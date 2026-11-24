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

const PROV = { provincia: 'Ciudad Real' };
const alta = (o = {}) => ({ ...ev(), ...PROV, ...o });
const sin = (...ks) => { const e = alta(); for (const k of ks) delete e[k]; return e; };
const servicio = () => { const store = new MemoryStore(); store.rows.set('amalia_catalog_guard/eventos', { data: { epoch: 0 }, updateTime: 'g0' }); return { store, events: new EventService(store, { get() { throw Error('no asset'); } }) }; };
const fallo = async p => { try { await p; return null; } catch (e) { return e; } };
const prep = (events, e) => events.prepareAdmission(e, owner);

test('una alta completa (fechaLocal ISO, municipio y provincia) se prepara y se admite', async () => {
  const { events } = servicio();
  const p = await prep(events, alta()); assert.equal(p.admisible, true);
  const r = await events.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: alta() }, owner); assert.ok(r.eventId);
});

test('falta fechaLocal: error missing_field que nombra el campo', async () => {
  const { events } = servicio();
  const e = await fallo(prep(events, sin('fechaLocal'))); assert.equal(e.code, 'missing_field'); assert.equal(e.details.campo, 'fechaLocal');
});

test('fechaLocal que no es ISO (AAAA-MM-DD) se rechaza con el campo y el formato', async () => {
  const { events } = servicio();
  for (const f of ['10/05/2099', '2099-5-10', '10 de mayo de 2099', '2099-05-10T20:00:00']) {
    const e = await fallo(prep(events, alta({ fechaLocal: f }))); assert.equal(e.code, 'invalid_local_date', f); assert.equal(e.details.campo, 'fechaLocal'); assert.match(e.details.ayuda, /AAAA-MM-DD/);
  }
});

test('falta el municipio (ni city ni ubicacion): error que nombra municipio', async () => {
  const { events } = servicio();
  const e = await fallo(prep(events, sin('city'))); assert.equal(e.code, 'missing_field'); assert.equal(e.details.campo, 'municipio');
  assert.equal((await fallo(prep(events, alta({ city: '   ' })))).details.campo, 'municipio');
});

test('falta la provincia: error que nombra provincia (también con ubicacion sin provincia)', async () => {
  const { events } = servicio();
  const e = await fallo(prep(events, sin('provincia'))); assert.equal(e.code, 'missing_field'); assert.equal(e.details.campo, 'provincia');
  assert.equal((await fallo(prep(events, alta({ provincia: ' ' })))).details.campo, 'provincia');
  assert.equal((await fallo(prep(events, sin('city', 'provincia', ...[]) && { ...sin('city', 'provincia'), ubicacion: { municipio: 'Almagro' } }))).details.campo, 'provincia');
});

test('ubicacion {municipio, provincia} cubre municipio y provincia sin city', async () => {
  const { events } = servicio();
  const e = { ...sin('city', 'provincia'), ubicacion: { municipio: 'Almagro', provincia: 'Ciudad Real' } };
  assert.equal((await prep(events, e)).admisible, true);
});

test('city, town, ciudad y ubicacion deben coincidir con el municipio; sin importar mayúsculas ni tildes', async () => {
  const { events } = servicio();
  for (const [campo, extra] of [['city', { ubicacion: { municipio: 'Almagro' }, city: 'Daimiel' }], ['town', { town: 'Daimiel' }], ['ciudad', { ciudad: 'Daimiel' }], ['ubicacion', { ubicacion: 'Daimiel' }]]) {
    const e = await fallo(prep(events, alta(extra)));
    assert.equal(e.code, 'conflicting_location', campo); assert.ok(e.details.campo, campo); assert.match(e.details.ayuda, /coincidir/);
  }
  const e = await fallo(prep(events, alta({ town: 'Daimiel' }))); assert.equal(e.details.campo, 'town'); assert.equal(e.details.municipio, 'Almagro');
  const bien = alta({ town: 'ALMAGRO', ciudad: 'almagro', ubicacion: { municipio: 'Almagro' } });
  assert.equal((await prep(events, bien)).admisible, true);
  assert.equal((await prep(events, alta({ city: 'Málaga', town: 'MALAGA', provincia: 'Málaga' }))).admisible, true);
});

test('admitir_candidato aplica la misma validación', async () => {
  const { events } = servicio();
  const p = await prep(events, alta());
  for (const [e, campo] of [[sin('provincia'), 'provincia'], [sin('fechaLocal'), 'fechaLocal'], [sin('city'), 'municipio']]) {
    const r = await fallo(events.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: e }, owner)); assert.equal(r.code, 'missing_field'); assert.equal(r.details.campo, campo);
  }
  const c = await fallo(events.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: alta({ ciudad: 'Daimiel' }) }, owner)); assert.equal(c.code, 'conflicting_location');
});

test('un lote de sesiones sin provincia se rechaza entero', async () => {
  const { events } = servicio();
  const ses = [{ fechaLocal: '2099-06-01', horaLocal: '20:00' }, { fechaLocal: '2099-06-02', horaLocal: '20:00' }];
  const e = await fallo(prep(events, { ...sin('fechaLocal', 'provincia'), temporalidad: { tipo: 'sesiones', sesiones: ses } }));
  assert.ok(e); assert.equal(e.code === 'missing_field' ? e.details.campo : (e.errores?.[0]?.campo), 'provincia');
  const bien = await prep(events, { ...alta(), fechaLocal: undefined, temporalidad: { tipo: 'sesiones', sesiones: ses } }); assert.equal(bien.multiple, true);
});

test('las ediciones de eventos ya existentes (sin provincia) no se ven afectadas', async () => {
  const { store, events } = servicio();
  const p = await prep(events, alta()); const r = await events.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: alta() }, owner);
  const row = store.rows.get('eventos/' + r.eventId); delete row.data.provincia;
  const u = await events.update({ eventId: r.eventId, negocioId: 'bizA', expectedVersion: row.data.version, changes: { precio: 5 }, reason: 'precio anunciado por la fuente' }, owner);
  assert.equal(store.rows.get('eventos/' + r.eventId).data.precio, 5); assert.ok(u);
});
