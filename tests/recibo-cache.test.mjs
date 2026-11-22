import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../event-domain.mjs';
import { EventService } from '../event-service.mjs';

const owner = { id: 'owner', actions: ['*'], businesses: ['*'] };
const other = { id: 'otro', actions: ['read'], businesses: ['*'] };
class Store {
  constructor() { this.rows = new Map(); this.listAllCalls = 0; this.listCalls = 0; }
  put(c, id, data, updateTime = '1') { this.rows.set(`${c}/${id}`, { data, updateTime }); }
  async get(c, id) { const r = this.rows.get(`${c}/${id}`); return r ? { id, ...structuredClone(r) } : null; }
  async list(c, { requestId } = {}) { this.listCalls++; return [...this.rows].filter(([k, r]) => k.startsWith(c + '/') && (!requestId || r.data.requestId === requestId)).map(([k, r]) => ({ id: k.split('/').at(-1), ...structuredClone(r) })); }
  async listAll(c) { this.listAllCalls++; return this.list(c); }
}
const keyOf = (actor, neg, rid) => 'req_' + hash(actor + '\0' + neg + '\0' + rid).slice(0, 40);
function setup() {
  const s = new Store();
  s.put('negocios', 'bizA', { nombre: 'Ayuntamiento' });
  s.put('amalia_catalog_guard', 'eventos', { epoch: 1 }, 'g1');
  s.put('eventos', 'ev1', { negocioId: 'bizA', titulo: 'Taller', requestId: 'req-1', version: 1 });
  s.put('amalia_event_requests', keyOf('owner', 'bizA', 'req-1'), { eventId: 'ev1', actor: 'owner', negocioId: 'bizA' });
  return { s, svc: new EventService(s, {}, { warm: false }) };
}

test('recibo: se consulta solo con requestId, con o sin negocioId', async () => {
  const { svc } = setup();
  const a = await svc.registryAdmissionReceipt({ requestId: 'req-1' }, owner);
  assert.equal(a.estado, 'guardado'); assert.equal(a.eventId, 'ev1'); assert.equal(a.negocioId, 'bizA');
  const b = await svc.registryAdmissionReceipt({ negocioId: 'bizA', requestId: 'req-1' }, owner);
  assert.equal(b.eventId, 'ev1');
});

test('recibo: otro agente no ve el recibo ajeno y un requestId desconocido da not_found', async () => {
  const { svc } = setup();
  await assert.rejects(svc.registryAdmissionReceipt({ requestId: 'req-1' }, other), /admission_receipt_not_found/);
  await assert.rejects(svc.registryAdmissionReceipt({ requestId: 'no-existe' }, owner), /admission_receipt_not_found/);
});

test('recibo: una admisión en curso devuelve en_proceso, no un vacío', async () => {
  const { svc } = setup();
  svc.inflight.set('owner\0req-2', { negocioId: 'bizA', desde: '2026-11-19T10:00:00Z' });
  const r = await svc.registryAdmissionReceipt({ requestId: 'req-2' }, owner);
  assert.equal(r.estado, 'en_proceso'); assert.equal(r.negocioId, 'bizA');
  const r2 = await svc.registryAdmissionReceipt({ negocioId: 'bizA', requestId: 'req-2' }, owner);
  assert.equal(r2.estado, 'en_proceso');
  await assert.rejects(svc.registryAdmissionReceipt({ requestId: 'req-2' }, other), /admission_receipt_not_found/);
});

test('universo del catálogo: se reutiliza mientras la guardia no cambia y se recarga cuando cambia', async () => {
  const { s, svc } = setup();
  await svc.catalogUniverse(); await svc.catalogUniverse(); await svc.catalogUniverse();
  assert.equal(s.listAllCalls, 2, 'una lectura de eventos + una de reservas');
  s.put('amalia_catalog_guard', 'eventos', { epoch: 2 }, 'g2');
  await svc.catalogUniverse();
  assert.equal(s.listAllCalls, 4);
});

test('universo del catálogo: cargas simultáneas comparten una sola lectura', async () => {
  const { s, svc } = setup();
  await Promise.all([svc.catalogUniverse(), svc.catalogUniverse(), svc.catalogUniverse()]);
  assert.equal(s.listAllCalls, 2);
});

// ---- 2.16.1: caché incremental tras escrituras propias con guardia ----
class WStore extends Store {
  constructor() { super(); this.n = 0; }
  async write(c, id, data, { guard, reserve } = {}) {
    if (c === 'eventos' && guard && this.rows.get('amalia_catalog_guard/eventos').updateTime !== guard.updateTime) throw new Error('version_conflict');
    const ut = 'w' + (++this.n);
    this.put(c, id, structuredClone(data), ut);
    if (reserve) this.put('amalia_event_reservations', reserve.id, structuredClone(reserve.data), ut);
    if (c === 'eventos') this.put('amalia_catalog_guard', 'eventos', { epoch: 1 }, ut);
    return { id, data, updateTime: ut };
  }
}
function wsetup() {
  const s = new WStore();
  s.put('negocios', 'bizA', { nombre: 'Ayuntamiento' });
  s.put('amalia_catalog_guard', 'eventos', { epoch: 1 }, 'g1');
  s.put('eventos', 'ev1', { negocioId: 'bizA', titulo: 'Uno', version: 1 });
  return { s, svc: new EventService(s, {}) };
}

test('caché: una escritura propia con precondición de guardia se aplica a la caché sin recargar el catálogo', async () => {
  const { s, svc } = wsetup();
  await svc.catalogUniverse();
  const base = s.listAllCalls;
  const g = (await s.get('amalia_catalog_guard', 'eventos')).updateTime;
  await s.write('eventos', 'ev2', { negocioId: 'bizA', titulo: 'Dos', version: 1 }, { create: true, guard: { updateTime: g }, reserve: { id: 'res_1', data: { eventId: 'ev2', negocioId: 'bizA' } } });
  const u = await svc.catalogUniverse();
  assert.equal(s.listAllCalls, base, 'no hubo recarga completa');
  assert.ok(u.docs.some(d => d.id === 'ev2'), 'el evento nuevo está en la caché');
  assert.ok(u.reservas.some(r => r.id === 'res_1' && r.eventId === 'ev2'));
  assert.equal(u.docs.length, 2);
});

test('caché: una escritura sin precondición de guardia invalida la caché y fuerza recarga', async () => {
  const { s, svc } = wsetup();
  await svc.catalogUniverse();
  const base = s.listAllCalls;
  await s.write('eventos', 'ev3', { negocioId: 'bizA', titulo: 'Tres', version: 1 });
  await new Promise(r => setTimeout(r, 20));
  const u = await svc.catalogUniverse();
  assert.ok(s.listAllCalls > base, 'recargó');
  assert.ok(u.docs.some(d => d.id === 'ev3'));
});

test('caché: nunca hay dos cargas simultáneas aunque la guardia cambie durante la carga', async () => {
  const { s, svc } = wsetup();
  let activas = 0, maxActivas = 0;
  const orig = s.listAll.bind(s);
  s.listAll = async (...a) => { activas++; maxActivas = Math.max(maxActivas, activas); await new Promise(r => setTimeout(r, 15)); const out = await orig(...a); activas--; return out; };
  const p1 = svc.catalogUniverse();
  s.put('amalia_catalog_guard', 'eventos', { epoch: 1 }, 'g9');
  const p2 = svc.catalogUniverse();
  await Promise.all([p1, p2]);
  assert.equal(maxActivas, 1);
});
