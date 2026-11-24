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
const ev = () => ({ negocioId: 'bizA', titulo: 'Concierto de ensayo', descripcion: 'Evento de ensayo.', city: 'Almagro', provincia: 'Provincia de prueba', fechaLocal: '2099-05-10', horaLocal: '20:00', timeZone: 'Europe/Madrid', fuentes: [{ url: EV, checkedAt: '2026-11-01T10:00:00.000Z' }] });
async function fx() { const store = new MemoryStore(), events = new EventService(store, { get() { throw Error('no asset'); } }), e = await events.create(ev(), owner); return { store, events, e, row: () => store.rows.get('eventos/' + e.eventId).data }; }
const upd = (f, changes, o = {}) => f.events.update({ eventId: f.e.eventId, negocioId: 'bizA', expectedVersion: f.row().version, changes, reason: 'cambio anunciado por la fuente', ...o }, owner);
const code = p => p.then(() => null, e => e.code);

test('editar_evento acepta fuenteId (existente) y rechaza el que no existe o es inválido', async () => {
  const f = await fx();
  assert.equal(await code(upd(f, { fuenteId: 'basura' })), 'invalid_source_id');
  assert.equal(await code(upd(f, { fuenteId: 'fte_municipio_' + 'b'.repeat(24) })), 'source_not_found');
  const sim = await upd(f, { fuenteId: FTE }, { simular: true }); assert.equal(sim.camposQueCambian.includes('fuenteId'), true); assert.equal(f.row().fuenteId, undefined);
  await upd(f, { fuenteId: FTE }); assert.equal(f.row().fuenteId, FTE);
});

test('editar_evento cambia link con evidenciaUrl; sin ella se exige', async () => {
  const f = await fx();
  assert.equal(await code(upd(f, { link: EVID })), 'evidence_required');
  await upd(f, { link: EVID }, { evidenciaUrl: EVID }); assert.equal(f.row().link, EVID);
});

test('editar_evento añade sesiones a una ficha existente, pero no quita ni adelanta', async () => {
  const f = await fx(), s = (fechaLocal, horaLocal = '20:00') => ({ fechaLocal, horaLocal });
  assert.equal(await code(upd(f, { sesiones: [s('2099-05-10'), s('2099-05-11')] })), 'evidence_required');
  await upd(f, { sesiones: [s('2099-05-10'), s('2099-05-11'), s('2099-05-12')] }, { evidenciaUrl: EVID });
  assert.equal(f.row().sesiones.length, 3); assert.equal(f.row().fechaFinLocal, '2099-05-12'); assert.equal(f.row().fechaLocal, '2099-05-10');
  assert.equal(await code(upd(f, { sesiones: [s('2099-05-10'), s('2099-05-12')] }, { evidenciaUrl: EVID })), 'sessions_cannot_be_removed');
  assert.equal(await code(upd(f, { sesiones: [s('2099-05-09'), s('2099-05-10'), s('2099-05-11'), s('2099-05-12')] }, { evidenciaUrl: EVID })), 'session_before_primary');
});

test('editar_negocio quita sitioWeb si queda otra fuente; si no, lo impide', async () => {
  const store = new MemoryStore(), p = owner;
  store.rows.set('negocios/biz_sin_red', { data: { nombre: 'Solo web', version: 0, fuentesInformacion: { sitioWeb: 'https://solo.example.es' } }, updateTime: '1' });
  store.rows.set('negocios/biz_con_red', { data: { nombre: 'Web y red', version: 0, fuentesInformacion: { sitioWeb: 'https://web.example.es', instagram: 'https://instagram.com/web' } }, updateTime: '1' });
  assert.equal(await code(editarNegocio(store, { negocioId: 'biz_sin_red', expectedVersion: 0, motivo: 'quitar web', sitioWeb: null }, p)), 'source_required');
  const r = await editarNegocio(store, { negocioId: 'biz_con_red', expectedVersion: 0, motivo: 'quitar web', sitioWeb: null }, p);
  assert.equal(r.escrito, true); assert.equal(store.rows.get('negocios/biz_con_red').data.fuentesInformacion.sitioWeb, undefined); assert.ok(store.rows.get('negocios/biz_con_red').data.fuentesInformacion.instagram);
});

test('decidir_hilo valida «decision» con errores claros', async () => {
  const store = new MemoryStore(), alfred = { id: 'alfred', actions: ['read', 'board', 'board_admin'], businesses: ['*'] };
  const h = await publicar(store, { tipo: 'duda', asunto: 'Una duda', texto: 'x' }, { id: 'lola', actions: ['read', 'board'], businesses: ['*'] });
  for (const [dec, esperado] of [[undefined, 'board_decision_requerida'], [null, 'board_decision_requerida'], ['', 'board_decision_requerida'], ['   ', 'board_decision_requerida'], [{ a: 1 }, 'board_decision_invalida'], [42, 'board_decision_invalida'], ['x'.repeat(2001), 'board_decision_invalida']])
    assert.equal(await code(decidirHilo(store, { hilo: h.hilo, decision: dec }, alfred)), esperado);
  assert.equal((await decidirHilo(store, { hilo: h.hilo, decision: 'Adelante' }, alfred)).decidido, true);
});
