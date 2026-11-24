import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../event-domain.mjs';
import { HistoricalFixtureService as EventService } from './helpers/historical-fixtures.mjs';
import { editarNegocio } from '../negocio-edicion.mjs';
import { publicar, decidirHilo } from '../tablon.mjs';

const owner = { id: 'owner', actions: ['*'], businesses: ['*'] };
const EV = 'https://almagro.es/agenda/concierto', EVID = 'https://almagro.es/agenda/concierto-ficha';
const FTE = 'fte_municipio_' + 'a'.repeat(24);

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
const code = p => p.then(() => null, e => e.code);

import { agenteCanonico, esAgente, esAgenteBaja, esAgenteHistorico, AGENTES, AGENTES_BAJA, conIdentidad } from '../identidad.mjs';
import { createApp } from '../server-v2.mjs';
import { hash } from '../event-domain.mjs';
import { actualizarFuente, registrarFuente, readRegistry } from '../registro-fuentes.mjs';
import { publicar as publicarTablon, marcarLeido, listar as listarTablon } from '../tablon.mjs';

test('identidad: alfie ya no es agente activo, pero se sigue reconociendo en el historial', () => {
  assert.equal(AGENTES.includes('alfie'), false); assert.deepEqual(AGENTES_BAJA, ['alfie']);
  assert.equal(esAgente('alfie'), false); assert.equal(esAgenteBaja('alfie'), true); assert.equal(esAgenteHistorico('alfie'), true);
  assert.equal(agenteCanonico('alfie'), 'alfie', 'createdBy/updatedBy «alfie» siguen resolviéndose a alfie');
  assert.equal(esAgente('noodle'), true); assert.equal(esAgenteBaja('noodle'), false);
  assert.equal(conIdentidad({ id: 'alfie', actions: ['read'], businesses: ['*'] }).agente, 'alfie');
});

test('el historial de alfie se sigue leyendo y contando en los listados de días pasados', async () => {
  const store = new MemoryStore(); store.rows.set('amalia_catalog_guard/eventos', { data: { epoch: 0 }, updateTime: 'g0' });
  const fila = (id, by, cuando) => store.rows.set('eventos/' + id, { data: { negocioId: 'bizA', titulo: 'Evento ' + id, city: 'Almagro', provincia: 'Ciudad Real', fechaLocal: '2099-05-10', createdBy: by, updatedBy: by, agenteCanonico: by, fechaCreacion: cuando, fuentes: [{ url: 'https://a.es/' + id }], version: 1 }, updateTime: '1' });
  fila('ev_a1', 'alfie', '2026-11-20T09:00:00.000Z'); fila('ev_a2', 'alfie', '2026-11-20T15:00:00.000Z'); fila('ev_a3', 'alfie', '2026-11-23T10:00:00.000Z'); fila('ev_n1', 'noodle', '2026-11-20T10:00:00.000Z');
  const events = new EventService(store, { get() { throw Error('no asset'); } });
  const pasado = await events.listRecentAdmissions({ agente: 'alfie', desde: '2026-11-20T00:00:00.000Z', hasta: '2026-11-20T23:59:59.999Z' }, owner);
  assert.equal(pasado.total, 2); assert.deepEqual(pasado.items.map(i => i.eventId).sort(), ['ev_a1', 'ev_a2']); assert.ok(pasado.items.every(i => i.createdBy === 'alfie' && i.agente === 'alfie'));
  assert.equal((await events.listRecentAdmissions({ createdBy: 'alfie' }, owner)).total, 3);
  assert.equal((await events.listRecentAdmissions({ desde: '2026-11-20T00:00:00.000Z', hasta: '2026-11-20T23:59:59.999Z' }, owner)).total, 3, 'cuenta junto a los demás agentes ese día');
});

test('token revocado: sin la entrada de alfie en el registro da 401, y los demás tokens siguen entrando', async () => {
  const p = (id, tok) => ({ id, tokenHash: hash(tok), actions: ['*'], businesses: ['*'] });
  const ctx = { editorial: { pausedNow: () => true }, publicBase: 'https://example.org', media: { serve: () => null } };
  const llama = async (registro, tok) => { const app = createApp(ctx, registro); await new Promise(r => app.listen(0, '127.0.0.1', r)); try { return (await fetch('http://127.0.0.1:' + app.address().port + '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + tok } })).status; } finally { app.close(); } };
  const antes = [p('alfie', 'token-alfie-ensayo'), p('conchi', 'token-conchi-ensayo'), p('noodle', 'token-noodle-ensayo')], despues = antes.filter(x => x.id !== 'alfie');
  assert.equal(await llama(antes, 'token-alfie-ensayo'), 200);
  assert.equal(await llama(despues, 'token-alfie-ensayo'), 401);
  assert.equal(await llama(despues, 'token-conchi-ensayo'), 200); assert.equal(await llama(despues, 'token-noodle-ensayo'), 200);
});

test('fuente con responsable alfie: se pasa a noodle con motivo y auditoría, y la fusionada conserva su historial', async () => {
  const docs = new Map(), store = {
    async get(c, id) { const r = docs.get(c + '/' + id); return r ? { id, data: structuredClone(r.data), updateTime: r.updateTime } : null; },
    async list(c) { return [...docs].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.split('/').at(-1), data: structuredClone(r.data), updateTime: r.updateTime })); },
    async write(c, id, data, o = {}) { const k = c + '/' + id; if (o.create && docs.has(k)) throw new DomainError('version_conflict'); docs.set(k, { data: structuredClone(data), updateTime: String(Date.now() + Math.random()) }); return {}; }
  };
  const alt = conIdentidad({ id: 'alfred-ediciones', actions: ['read', 'register_source'], businesses: ['*'] });
  const r = await registrarFuente(store, { canal: 'web', url: 'https://albadetormes.example/agenda', nombreEntidad: 'Ayuntamiento de Alba de Tormes', municipio: 'Alba de Tormes', provincia: 'Salamanca', via: 'Web oficial' }, conIdentidad({ id: 'alfie', actions: ['read', 'register_source'], businesses: ['*'] }));
  assert.equal(docs.get('registro_fuentes/' + r.fuenteId).data.responsable, 'alfie');
  const u = await actualizarFuente(store, { fuenteId: r.fuenteId, responsable: 'noodle', motivo: 'Baja de Alfie: sus fuentes pasan a Noodle' }, alt);
  assert.equal(u.actualizada, true); assert.equal(docs.get('registro_fuentes/' + r.fuenteId).data.responsable, 'noodle');
  assert.equal((await readRegistry(store)).find(f => f.id === r.fuenteId).data.responsable, 'noodle');
});

test('tablón: un aviso a «todos» se cierra cuando leen todos los agentes ACTIVOS (alfie ya no hace falta)', async () => {
  const s = { docs: new Map(), async get(c, id) { const r = this.docs.get(c + '/' + id); return r ? { id, data: structuredClone(r.data), updateTime: r.updateTime } : null; }, async list(c) { return [...this.docs].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.split('/').at(-1), data: structuredClone(r.data), updateTime: r.updateTime })); }, async write(c, id, d) { this.docs.set(c + '/' + id, { data: structuredClone(d), updateTime: String(Math.random()) }); return {}; } };
  const autor = { id: 'baja-ensayo', actions: ['read', 'board'], businesses: ['*'] }, t = n => () => new Date(Date.parse('2026-11-24T10:00:00.000Z') + n * 1000).toISOString();
  const a = await publicarTablon(s, { tipo: 'aviso', asunto: 'Aviso general', texto: 'x' }, autor, { now: t(0) });
  const activos = AGENTES.filter(x => x !== 'susan');   // susan no tiene acceso al tablón; también cuenta como lector pendiente
  for (const ag of activos) await marcarLeido(s, { hilo: a.id }, { id: ag, actions: ['read', 'board'], businesses: ['*'] }, { now: t(60) });
  assert.equal(s.docs.get('tablon_agentes/' + a.id).data.estado, 'abierto', 'falta susan');
  await marcarLeido(s, { hilo: a.id }, { id: 'susan', actions: ['read', 'board'], businesses: ['*'] }, { now: t(120) });
  assert.equal(s.docs.get('tablon_agentes/' + a.id).data.estado, 'resuelto'); assert.equal(s.docs.get('tablon_agentes/' + a.id).data.resuelto_por, 'sistema');
  assert.equal((await listarTablon(s, { hilo: a.id }, autor)).estado, 'resuelto');
});
