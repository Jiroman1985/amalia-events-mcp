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
import { precioACambios } from '../server-v2.mjs';

test('precio desconocido: precioEstado/precioDetalle/precio:null se traducen a precioInfo y se guardan', async () => {
  const f = await fx();
  await upd(f, precioACambios({ precio: 5 })); assert.equal(f.row().precio, 5);
  await upd(f, precioACambios({ precioEstado: 'desconocido', precioDetalle: 'No consta en la web', precio: null }));
  const r = f.row(); assert.equal(r.precio, null); assert.equal(r.precioEstado, 'desconocido'); assert.equal(r.precioDetalle.textoOriginal, 'No consta en la web');
  await upd(f, precioACambios({ precio: 7 })); assert.equal(f.row().precioEstado, 'precio');
  await upd(f, precioACambios({ precio: null })); assert.equal(f.row().precioEstado, 'desconocido'); assert.equal(f.row().precio, null);
});

test('precioACambios: combinaciones inválidas', () => {
  assert.throws(() => precioACambios({ precioEstado: 'desconocido', precio: 3 }), /invalid_changes/);
  assert.throws(() => precioACambios({ precioDetalle: 'x' }), /invalid_changes/);
  assert.throws(() => precioACambios({ precio: null, precioInfo: { estado: 'gratis' } }), /invalid_changes/);
  assert.deepEqual(precioACambios({ titulo: 'a' }), { titulo: 'a' });
});
