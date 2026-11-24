import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';
import { DomainError, authorize } from '../event-domain.mjs';
import { claveSesion, clavesDeEvento, normalizarUrl, recintoClave } from '../clave-sesion.mjs';

const yieldNow = () => new Promise(r => setImmediate(r));
class MemoryStore {
  constructor() { this.rows = new Map([['negocios/b', { data: { nombre: 'N' }, updateTime: '1' }], ['amalia_catalog_guard/eventos', { data: { epoch: 1 }, updateTime: 'g1' }]]); this.seq = 1; this.fullScans = 0; }
  async get(c, id) { await yieldNow(); const r = this.rows.get(c + '/' + id); return r ? { id, ...structuredClone(r) } : null; }
  async list(c, o = {}) {
    await yieldNow(); if (c === 'eventos') this.fullScans++;
    return [...this.rows].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.slice(c.length + 1), ...structuredClone(r) }))
      .filter(r => Object.entries(o.eq || {}).every(([k, v]) => String(r.data[k]) === String(v))).filter(r => !o.estado || r.data.estado === o.estado).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, o.limit || 500);
  }
  async listAll(c) { this.fullScans++; return this.list(c); }
  async write(c, id, data, o = {}) {
    await yieldNow(); // a partir de aquí todo es síncrono: el commit es atómico, como en Firestore
    const key = c + '/' + id, cur = this.rows.get(key);
    if ((o.create && cur) || (!o.create && cur && o.updateTime !== cur.updateTime)) throw new DomainError('version_conflict');
    for (const k of o.claves?.crear || []) if (this.rows.has('sesiones_clave/' + k.id)) throw new DomainError('version_conflict');
    for (const k of o.claves?.actualizar || []) { const r = this.rows.get('sesiones_clave/' + k.id); if (!r || r.updateTime !== k.updateTime) throw new DomainError('version_conflict'); }
    if (o.reserve) { const r = this.rows.get('amalia_event_reservations/' + o.reserve.id); if (o.reserve.updateTime ? (!r || r.updateTime !== o.reserve.updateTime) : !!r) throw new DomainError('version_conflict'); }
    if (o.moveReserve) {
      this.huboBorrado = this.huboBorrado || false;
      if (o.moveReserve.fromRow) { const r = this.rows.get('amalia_event_reservations/' + o.moveReserve.from); if (!r || r.updateTime !== o.moveReserve.fromRow.updateTime) throw new DomainError('version_conflict'); }
      const t = this.rows.get('amalia_event_reservations/' + o.moveReserve.to.id); if (o.moveReserve.to.updateTime ? (!t || t.updateTime !== o.moveReserve.to.updateTime) : !!t) throw new DomainError('version_conflict');
    }
    const next = o.updateFields && cur ? { ...cur.data, ...data } : structuredClone(data);
    this.rows.set(key, { data: next, updateTime: 'u' + (++this.seq) });
    if (o.request) this.rows.set('amalia_event_requests/' + o.request.id, { data: o.request.data, updateTime: 'u' + this.seq });
    if (o.reserve) this.rows.set('amalia_event_reservations/' + o.reserve.id, { data: { ...o.reserve.data, estado: 'activa' }, updateTime: 'u' + this.seq });
    if (o.moveReserve) {
      if (o.moveReserve.fromRow) this.rows.set('amalia_event_reservations/' + o.moveReserve.from, { data: { ...o.moveReserve.fromRow.data, estado: 'liberada', eventId: null }, updateTime: 'u' + this.seq });
      this.rows.set('amalia_event_reservations/' + o.moveReserve.to.id, { data: { ...o.moveReserve.to.data, estado: 'activa' }, updateTime: 'u' + this.seq });
    }
    for (const k of o.claves?.crear || []) this.rows.set('sesiones_clave/' + k.id, { data: structuredClone(k.data), updateTime: 'u' + this.seq });
    for (const k of o.claves?.actualizar || []) this.rows.set('sesiones_clave/' + k.id, { data: structuredClone(k.data), updateTime: 'u' + this.seq });
    if (c === 'eventos') this.rows.set('amalia_catalog_guard/eventos', { data: { epoch: this.seq }, updateTime: 'g' + this.seq });
    return { id, updateTime: 'u' + this.seq };
  }
  async writeMany(items, o = {}) {
    await yieldNow(); this.writeManyCalls = (this.writeManyCalls || 0) + 1;
    for (const it of items) { const cur = this.rows.get('eventos/' + it.key); if (!cur || cur.updateTime !== it.updateTime) throw new DomainError('version_conflict'); }
    for (const k of o.claves?.crear || []) if (this.rows.has('sesiones_clave/' + k.id)) throw new DomainError('version_conflict');
    for (const k of o.claves?.actualizar || []) { const r = this.rows.get('sesiones_clave/' + k.id); if (!r || r.updateTime !== k.updateTime) throw new DomainError('version_conflict'); }
    if (this.fallarSegundaEscritura) throw new DomainError('firestore_http_403');
    this.seq++;
    for (const it of items) this.rows.set('eventos/' + it.key, { data: { ...this.rows.get('eventos/' + it.key).data, ...structuredClone(it.data) }, updateTime: 'u' + this.seq });
    for (const k of o.claves?.crear || []) this.rows.set('sesiones_clave/' + k.id, { data: structuredClone(k.data), updateTime: 'u' + this.seq });
    for (const k of o.claves?.actualizar || []) this.rows.set('sesiones_clave/' + k.id, { data: structuredClone(k.data), updateTime: 'u' + this.seq });
    this.rows.set('amalia_catalog_guard/eventos', { data: { epoch: this.seq }, updateTime: 'g' + this.seq });
    return {};
  }
  async revisions() { return []; }
  clavesTodas() { return [...this.rows].filter(([k]) => k.startsWith('sesiones_clave/')).map(([id, r]) => ({ id: id.slice(15), ...r.data })); }
  claves() { return [...this.rows].filter(([k]) => k.startsWith('sesiones_clave/')).map(([, r]) => r.data).filter(d => d.estado !== 'liberada'); }
  eventos() { return [...this.rows].filter(([k]) => k.startsWith('eventos/')).map(([k, r]) => ({ id: k.slice(8), data: r.data })); }
}
const alfred = { id: 'alfred', actions: ['*'], businesses: ['*'], agente: 'alfred' };
const conchi = { id: 'conchi', actions: ['admit', 'read', 'complete', 'admit_test'], businesses: ['*'], agente: 'conchi' };
const mk = (modo = 'bloquea') => { const store = new MemoryStore(); return { store, ev: new EventService(store, { get() { throw Error('sin imagen'); } }, { warm: false, claves: modo }) }; };
let n = 0;
const ficha = (o = {}) => ({ negocioId: 'b', titulo: 'Titulo ' + (++n), descripcion: 'Descripción del evento.', city: 'Zizur Mayor', provincia: 'Provincia de prueba', timeZone: 'Europe/Madrid', fuentes: [{ url: 'https://example.org/a/' + n, checkedAt: '2026-11-20T10:00:00Z' }], verificationStatus: 'capturado', fechaLocal: '2099-11-28', horaLocal: '20:00', lugar: 'Casa de Cultura de Zizur Mayor', requestId: 'req-' + n, ...o });
const alta = async (ev, input, p = alfred) => { const pr = await ev.prepareAdmission(input, p); return ev.admitCandidate({ accion: 'admit', proposalHash: pr.proposalHash, evento: input }, p); };
const codigo = async fn => { try { await fn(); return null; } catch (e) { return e instanceof DomainError ? e.code : 'otro:' + e.message; } };
import { decidirSesion, sesionesDeEvento } from '../clave-sesion.mjs';

const LUGAR = 'Sala de Exposiciones de Santo Domingo de la Cruz', burela = (o = {}) => ficha({ city: 'Burela', provincia: 'Lugo', lugar: 'Casa da Cultura de Burela', fechaLocal: '2026-11-28', ...o });
const taller = (o = {}) => ficha({ titulo: 'Taller de estampación y visita guiada', city: 'Salamanca', provincia: 'Salamanca', lugar: LUGAR, horaLocal: '12:00', fechaLocal: '2026-12-05', ...o });
const claves = async (ev, input) => (await ev.scanPorClaves(await ev.canonicalForAdmission(input, alfred))).claves.decision;
const scan = async (ev, input) => ev.scanPorClaves(await ev.canonicalForAdmission(input, alfred));

test('periodo: sus días generan claves marcadas; las sesiones explícitas y las sueltas no', () => {
  const d = { negocioId: 'b', titulo: 'Taller', city: 'Salamanca', lugar: LUGAR, fechaLocal: '2026-11-28', fechaFinLocal: '2026-12-19', horaLocal: '12:00' };
  const k = clavesDeEvento('ev_p', d);
  assert.equal(k.length, 22); assert.ok(k.every(c => c.data.periodo === true && c.data.periodoFin === '2026-12-19'));
  assert.ok(clavesDeEvento('ev_s', { ...d, fechaFinLocal: undefined }).every(c => !('periodo' in c.data)));
  assert.ok(clavesDeEvento('ev_x', { ...d, sesiones: [{ fechaLocal: '2026-11-28', horaLocal: '12:00' }, { fechaLocal: '2026-12-05', horaLocal: '12:00' }] }).every(c => !('periodo' in c.data)));
  assert.equal(sesionesDeEvento({ ...d, fechaFinLocal: undefined }).some(s => s.periodo), false);
});

test('ficha con periodo (28-11 al 19-12): una sesión suelta dentro del periodo va a la cola, no a bloqueo', async () => {
  const { ev } = mk('bloquea');
  const periodo = await alta(ev, taller({ fechaLocal: '2026-11-28', fechaFinLocal: '2026-12-19' }));
  assert.ok(periodo.eventId);
  for (const f of ['2026-12-05', '2026-12-12', '2026-12-19']) {
    const r = await scan(ev, taller({ fechaLocal: f }));
    assert.equal(r.claves.decision, 'cola', f);
    const c = r.coincidencias.find(x => x.eventId === periodo.eventId); assert.ok(c); assert.equal(c.confianza, 'dudosa'); assert.ok(c.motivos.includes('sesion_suelta_y_ficha_con_periodo') || c.motivos.length > 0);
  }
  assert.equal(await claves(ev, taller({ fechaLocal: '2027-01-09' })), 'libre', 'fuera del periodo no hay vecinos');
});

test('ficha con periodo: al revés (hay sesiones sueltas y entra la ficha con periodo) también va a la cola', async () => {
  const { ev } = mk('bloquea');
  await alta(ev, taller({ fechaLocal: '2026-12-05' }));
  assert.equal(await claves(ev, taller({ fechaLocal: '2026-11-28', fechaFinLocal: '2026-12-19' })), 'cola');
});

test('periodo frente a periodo (fichas solapadas del mismo evento) y suelta frente a suelta siguen bloqueando', async () => {
  const { ev } = mk('bloquea');
  await alta(ev, taller({ fechaLocal: '2026-12-05', fechaFinLocal: '2026-12-07', horaLocal: '12:00' }));
  assert.equal(await claves(ev, taller({ fechaLocal: '2026-12-06', fechaFinLocal: '2026-12-07', horaLocal: '12:00' })), 'bloquea', 'dos fichas con periodo');
  await alta(ev, taller({ titulo: 'Concierto de Navidad', fechaLocal: '2026-12-20', horaLocal: '20:00' }));
  assert.equal(await claves(ev, taller({ titulo: 'Concierto de Navidad', fechaLocal: '2026-12-20', horaLocal: '20:00' })), 'bloquea', 'dos sesiones sueltas idénticas');
});

test('decidirSesion: la regla del periodo es simétrica y solo rebaja bloqueos, no añade motivos', () => {
  const base = { eventId: 'ev_a', clave: 'salamanca|2026-12-05|12:00|sala', fuerza: 'fuerte', hora: '12:00', recinto: 'sala', titulo: 'taller', tituloOriginal: 'Taller' };
  const cand = { ...base, eventId: undefined, titulo: 'Taller' };
  assert.equal(decidirSesion(cand, [base]).decision, 'bloquea');
  const mixto = decidirSesion({ ...cand, periodo: true }, [base]); assert.equal(mixto.decision, 'cola'); assert.equal(mixto.motivos[0].motivo, 'sesion_suelta_y_ficha_con_periodo');
  assert.equal(decidirSesion(cand, [{ ...base, periodo: true }]).decision, 'cola');
  assert.equal(decidirSesion({ ...cand, periodo: true }, [{ ...base, periodo: true }]).decision, 'bloquea');
  assert.equal(decidirSesion({ ...cand, periodo: true, titulo: 'Otra cosa' }, [{ ...base, periodo: true }]).decision, 'cola');
  assert.equal(decidirSesion({ ...cand, periodo: true, clave: 'x|otra', hora: '09:00', recinto: 'otro', titulo: 'Cosa sin relación' }, [base]).decision, 'libre');
});

test('Moi Animal en Burela: dos funciones a distinta hora no se bloquean solo por el cruce de horas', async () => {
  const { ev } = mk('bloquea');
  const a = await alta(ev, burela({ titulo: 'Moi Animal', horaLocal: '18:30' }));
  assert.ok(a.eventId);
  // Mismo título, otra hora: otra función → libre y se crea
  assert.equal(await claves(ev, burela({ titulo: 'Moi Animal', horaLocal: '21:00' })), 'libre');
  const b = await alta(ev, burela({ titulo: 'Moi Animal', horaLocal: '21:00' })); assert.ok(b.eventId && b.eventId !== a.eventId);
  // Título reescrito a otra hora solo frente a la función de las 18:30: nunca bloquea (cola como máximo)
  const { ev: ev2 } = mk('bloquea'); const a2 = await alta(ev2, burela({ titulo: 'Moi Animal', horaLocal: '18:30' }));
  const cruce = await scan(ev2, burela({ titulo: "'Moi Animal', monólogo de Xosé A. Touriñán (Burela)", horaLocal: '21:00' }));
  assert.notEqual(cruce.claves.decision, 'bloquea'); assert.ok(cruce.coincidencias.every(c => c.confianza !== 'exacta'));
  assert.ok(cruce.coincidencias.every(c => c.eventId === a2.eventId && c.motivos.includes('titulo_parecido_hora_distinta')));
});

test('Moi Animal en Burela: con las dos funciones creadas, un duplicado a las 21:00 solo choca (bloquea) con la de las 21:00', async () => {
  const { ev } = mk('bloquea');
  const f1830 = await alta(ev, burela({ titulo: 'Moi Animal', horaLocal: '18:30' })), f2100 = await alta(ev, burela({ titulo: 'Moi Animal', horaLocal: '21:00' }));
  const dup = await scan(ev, burela({ titulo: "'Moi Animal', monólogo de Xosé A. Touriñán (Burela)", horaLocal: '21:00' }));
  assert.equal(dup.claves.decision, 'bloquea');
  const exactas = dup.coincidencias.filter(c => c.confianza === 'exacta').map(c => c.eventId);
  assert.deepEqual(exactas, [f2100.eventId], 'solo la función de la misma hora bloquea');
  const cruzada = dup.coincidencias.find(c => c.eventId === f1830.eventId); assert.ok(!cruzada || cruzada.confianza === 'dudosa', 'la de las 18:30 como mucho es aviso');
});
