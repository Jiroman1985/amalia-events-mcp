import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../event-domain.mjs';
import { HistoricalFixtureService as EventService } from './helpers/historical-fixtures.mjs';
import { editarNegocio } from '../negocio-edicion.mjs';
import { publicar, decidirHilo } from '../tablon.mjs';

const owner = { id: 'owner', actions: ['*'], businesses: ['*'] };
const FTE = 'fte_municipio_' + 'a'.repeat(24);
const EV = 'https://almagro.es/agenda/concierto', EVID = 'https://almagro.es/agenda/concierto-ficha';

class MemoryStore {
  constructor() { this.rows = new Map([['negocios/bizA', { data: { nombre: 'Ayuntamiento de Almagro' }, updateTime: '1' }], ['registro_fuentes/' + FTE, { data: { estado: 'activa' }, updateTime: '1' }]]); this.seq = 1; }
  async get(c, id) { const r = this.rows.get(`${c}/${id}`); return r ? { id, ...structuredClone(r) } : null; }
  async list(c) { return [...this.rows].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.split('/').at(-1), ...structuredClone(r) })); }
  async write(c, id, data, { updateTime, create, updateFields } = {}) {
    const key = `${c}/${id}`, cur = this.rows.get(key);
    if ((create && cur) || (!create && cur?.updateTime !== updateTime)) throw new DomainError('version_conflict');
    let next = structuredClone(data);
    if (updateFields && cur) { next = structuredClone(cur.data); for (const f of updateFields) { if (f in data) next[f] = structuredClone(data[f]); else delete next[f]; } }
    this.rows.set(key, { data: next, updateTime: String(++this.seq) });
    if (c === 'eventos') { const g = this.rows.get('amalia_catalog_guard/eventos'); if (g) g.updateTime = 'g' + this.seq; }
    return {};
  }
}
const ev = () => ({ negocioId: 'bizA', titulo: 'Concierto de ensayo', descripcion: 'Evento de ensayo.', city: 'Almagro', fechaLocal: '2099-05-10', horaLocal: '20:00', timeZone: 'Europe/Madrid', fuentes: [{ url: EV, checkedAt: '2026-11-01T10:00:00.000Z' }] });
async function fx() { const store = new MemoryStore(), events = new EventService(store, { get() { throw Error('no asset'); } }), e = await events.create(ev(), owner); return { store, events, e, row: () => store.rows.get('eventos/' + e.eventId).data }; }
const upd = (f, changes, o = {}) => f.events.update({ eventId: f.e.eventId, negocioId: 'bizA', expectedVersion: f.row().version, changes, reason: 'cambio anunciado por la fuente', ...o }, owner);

// Almacén con consulta por rango (como Firestore): el catálogo completo NO se puede listar; solo se consulta por fecha. Cuenta los documentos leídos.
class IndexedStore extends MemoryStore {
  constructor() { super(); this.leidos = 0; this.consultas = []; }
  async write(c, id, data, o = {}) { if (c === 'eventos' && o.guard?.updateTime && this.rows.get('amalia_catalog_guard/eventos')?.updateTime !== o.guard.updateTime) throw new DomainError('version_conflict'); return super.write(c, id, data, o); }
  async list(c, o) { if (c === 'eventos') throw new Error('full_scan_forbidden'); return super.list(c, o); }
  async queryRango(c, campo, desde, hasta) {
    const out = [...this.rows].filter(([k, r]) => k.startsWith(c + '/') && typeof r.data[campo] === 'string' && r.data[campo] >= desde && r.data[campo] <= hasta).map(([k, r]) => ({ id: k.split('/').at(-1), ...structuredClone(r) }));
    this.consultas.push({ campo, desde, hasta, n: out.length }); this.leidos += out.length; return out;
  }
}
const relleno = (store, n) => {
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2099, 5, 1 + (i % 300))).toISOString().slice(0, 10);
    store.rows.set('eventos/ev_relleno_' + i, { data: { negocioId: 'bizA', titulo: 'Actividad de relleno ' + i, city: 'Ciudad ' + (i % 40), fechaLocal: d, horaLocal: '10:00', fuentes: [{ url: 'https://relleno.es/' + i }], version: 1 }, updateTime: '1' });
  }
};
const nuevo = (over = {}) => ({ ...ev(), ...over });
async function banco(n = 5200) { const store = new IndexedStore(); store.rows.set('amalia_catalog_guard/eventos', { data: { epoch: 0 }, updateTime: 'g0' }); relleno(store, n); const events = new EventService(store, { get() { throw Error('no asset'); } }); return { store, events }; }
const motivosDe = p => (p.coincidencias || []).flatMap(c => c.motivos);

test('con más de 5.000 eventos la admisión no escanea el catálogo y no da incomplete_scan', async () => {
  const { store, events } = await banco(5200);
  assert.ok([...store.rows.keys()].filter(k => k.startsWith('eventos/')).length > 5000);
  const p = await events.prepareAdmission(nuevo({ fechaLocal: '2099-07-15' }), owner);
  assert.equal(p.admisible, true); assert.equal(p.coincidencias.length, 0);
  assert.ok(store.leidos < 100, 'solo se leen los candidatos de la ventana: ' + store.leidos);
  const a = await events.create(nuevo({ fechaLocal: '2099-07-15' }), owner); assert.ok(a.eventId);
});

test('detecta el duplicado (mismo día, municipio y hora) con título reescrito, dentro del catálogo grande', async () => {
  const { events } = await banco(5200);
  await events.create(nuevo({ titulo: 'Taller de corona navideña', city: 'Almagro', fechaLocal: '2099-08-20', horaLocal: '18:00' }), owner);
  const p = await events.prepareAdmission(nuevo({ titulo: 'Taller Corona de Navidad', city: 'Almagro', fechaLocal: '2099-08-20', horaLocal: '18:00', fuentes: [{ url: 'https://otra-fuente.es/taller', checkedAt: '2026-11-01T10:00:00.000Z' }] }), owner);
  assert.equal(p.admisible, false); assert.ok(motivosDe(p).includes('duplicado_sesion'));
});

test('un día antes o después también entra en la ventana; dos días no', async () => {
  const { store, events } = await banco(5200);
  const base = await events.create(nuevo({ titulo: 'Concierto de primavera', fechaLocal: '2099-09-10', horaLocal: '20:00' }), owner);
  store.leidos = 0;
  const p = await events.prepareAdmission(nuevo({ titulo: 'Concierto de primavera', fechaLocal: '2099-09-11', horaLocal: '20:00', fuentes: [{ url: EV, checkedAt: '2026-11-01T10:00:00.000Z' }] }), owner);
  assert.ok(p.informativas.concat(p.coincidencias).some(c => c.eventId === base.eventId), 'el vecino a un día se consulta');
  const lejos = await events.prepareAdmission(nuevo({ titulo: 'Concierto de primavera', fechaLocal: '2099-09-13', horaLocal: '20:00', fuentes: [{ url: 'https://lejos.es/x', checkedAt: '2026-11-01T10:00:00.000Z' }] }), owner);
  assert.equal(lejos.admisible, true);
});

test('los eventos pasados no se consultan: la ventana empieza hoy', async () => {
  const { store, events } = await banco(300);
  store.rows.set('eventos/ev_antiguo', { data: { negocioId: 'bizA', titulo: 'Antiguo', city: 'Almagro', fechaLocal: '2020-01-01', fuentes: [{ url: 'https://x.es/a' }], version: 1 }, updateTime: '1' });
  await events.prepareAdmission(nuevo({ fechaLocal: '2099-05-10' }), owner);
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  assert.ok(store.consultas.every(c => c.desde >= hoy), JSON.stringify(store.consultas));
});

test('documentos legacy (solo fecha_inicio) y la identidad calculada se detectan sin recorrer el catálogo', async () => {
  const { store, events } = await banco(5200);
  store.rows.set('eventos/ev_legacy', { data: { nombre: 'Concierto de otoño', ciudad: 'Almagro', fecha_inicio: '2099-10-05', enlace_original: 'https://legacy.es/otono', version: 1 }, updateTime: '1' });
  const p = await events.prepareAdmission(nuevo({ titulo: 'Concierto de otoño', fechaLocal: '2099-10-05', horaLocal: null, fuentes: [{ url: 'https://legacy.es/otono', checkedAt: '2026-11-01T10:00:00.000Z' }] }), owner);
  assert.ok((p.coincidencias.concat(p.informativas)).some(c => c.eventId === 'ev_legacy'));
  const a = await events.create(nuevo({ fechaLocal: '2099-11-11' }), owner);
  const otra = await events.prepareAdmission(nuevo({ fechaLocal: '2099-11-11' }), owner);
  assert.equal(otra.admisible, false); assert.ok(otra.coincidencias.some(c => c.eventId === a.eventId));
});

test('ficha con sesiones: cada sesión se comprueba con su propia ventana', async () => {
  const { events } = await banco(5200);
  await events.create(nuevo({ titulo: 'Teatro infantil', city: 'Almagro', fechaLocal: '2099-12-20', horaLocal: '17:00', fuentes: [{ url: 'https://a.es/teatro', checkedAt: '2026-11-01T10:00:00.000Z' }] }), owner);
  const p = await events.prepareAdmission(nuevo({ titulo: 'Teatro infantil', city: 'Almagro', fechaLocal: '2099-12-18', horaLocal: '17:00', sesiones: [{ fechaLocal: '2099-12-18', horaLocal: '17:00' }, { fechaLocal: '2099-12-20', horaLocal: '17:00' }], fuentes: [{ url: 'https://b.es/teatro', checkedAt: '2026-11-01T10:00:00.000Z' }] }), owner);
  assert.equal(p.admisible, false); assert.ok(p.coincidencias.some(c => c.sesion === '2099-12-20'));
});

test('altas simultáneas: solo una entra aunque el catálogo sea grande', async () => {
  const { events } = await banco(5200);
  const r = await Promise.allSettled([events.create(nuevo({ fechaLocal: '2099-06-30' }), owner), events.create(nuevo({ fechaLocal: '2099-06-30', fuentes: [{ url: 'https://dos.es/x', checkedAt: '2026-11-01T10:00:00.000Z' }] }), owner)]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
});
