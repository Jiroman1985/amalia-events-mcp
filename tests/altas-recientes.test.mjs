import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';

const owner = { id: 'owner', actions: ['*'], businesses: ['*'] };
const reader = { id: 'lector', actions: ['read'], businesses: ['bizA'] };
const noRead = { id: 'nadie', actions: ['admit'], businesses: ['*'] };
class Store {
  constructor() { this.rows = new Map(); }
  put(c, id, data, ut = '1') { this.rows.set(`${c}/${id}`, { data, updateTime: ut }); }
  async get(c, id) { const r = this.rows.get(`${c}/${id}`); return r ? { id, ...structuredClone(r) } : null; }
  async list(c) { return [...this.rows].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.split('/').at(-1), ...structuredClone(r) })).sort((a, b) => (a.id < b.id ? -1 : 1)); }
}
function setup() {
  const s = new Store();
  s.put('amalia_catalog_guard', 'eventos', { epoch: 1 }, 'g1');
  const ev = (id, o) => s.put('eventos', id, { negocioId: 'bizA', titulo: 'T ' + id, city: 'Mérida', provincia: 'Badajoz', createdBy: 'alfie', requestId: 'r-' + id, fechaCreacion: '2026-11-19T10:00:00.000Z', ...o });
  ev('ev_1', { fechaCreacion: '2026-11-17T09:00:00.000Z' });
  ev('ev_2', { fechaCreacion: '2026-11-18T09:00:00.000Z', createdBy: 'alfred' });
  ev('ev_3', { fechaCreacion: '2026-11-19T09:00:00.000Z', provincia: 'Madrid', city: 'Getafe' });
  ev('ev_4', { fechaCreacion: '2026-11-19T11:00:00.000Z', retirado: true });
  ev('ev_5', { fechaCreacion: '2026-11-19T12:00:00.000Z', prueba: true });
  ev('ev_6', { fechaCreacion: '2026-11-19T13:00:00.000Z', negocioId: 'bizB' });
  ev('ev_7', { fechaCreacion: undefined });
  return new EventService(s, {}, { warm: false });
}

test('orden descendente, excluye retirados y pruebas, y devuelve los campos pedidos', async () => {
  const r = await setup().listRecentAdmissions({}, owner);
  assert.deepEqual(r.items.map(i => i.eventId), ['ev_6', 'ev_3', 'ev_2', 'ev_1', 'ev_7']);
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['agente', 'city', 'createdBy', 'eventId', 'fechaCreacion', 'negocioId', 'provincia', 'requestId', 'titulo']);
  assert.equal(r.total, 5); assert.equal(r.cursor, null);
});

test('filtra por createdBy, provincia y rango de fechas', async () => {
  const svc = setup();
  assert.deepEqual((await svc.listRecentAdmissions({ createdBy: 'alfred' }, owner)).items.map(i => i.eventId), ['ev_2']);
  assert.deepEqual((await svc.listRecentAdmissions({ provincia: 'MADRID' }, owner)).items.map(i => i.eventId), ['ev_3']);
  const r = await svc.listRecentAdmissions({ desde: '2026-11-18T00:00:00Z', hasta: '2026-11-19T10:00:00Z' }, owner);
  assert.deepEqual(r.items.map(i => i.eventId), ['ev_3', 'ev_2']);
});

test('paginación con cursor sin repetir ni saltar eventos', async () => {
  const svc = setup(), vistos = []; let cursor;
  do { const r = await svc.listRecentAdmissions({ limit: 2, cursor }, owner); vistos.push(...r.items.map(i => i.eventId)); cursor = r.cursor; } while (cursor);
  assert.deepEqual(vistos, ['ev_6', 'ev_3', 'ev_2', 'ev_1', 'ev_7']);
});

test('respeta negocios del principal, exige read y valida fechas y cursor', async () => {
  const svc = setup();
  assert.ok((await svc.listRecentAdmissions({}, reader)).items.every(i => i.negocioId === 'bizA'));
  await assert.rejects(svc.listRecentAdmissions({}, noRead), /forbidden/);
  await assert.rejects(svc.listRecentAdmissions({ desde: 'ayer' }, owner), e => e.code === 'invalid_date');
  await assert.rejects(svc.listRecentAdmissions({ cursor: 'basura' }, owner), e => e.code === 'invalid_cursor');
});
