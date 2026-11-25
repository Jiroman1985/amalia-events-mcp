import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';
import { registrySnapshot } from '../registro-provenance.mjs';
import { hash } from '../event-domain.mjs';

// Caso real (25/11): «Zambomba» en Arcos de la Frontera existía y buscar_duplicados_global devolvía 0 con exhaustivo=true.
const ZAMBOMBA = { titulo: 'Zambomba «Arcos-Jerez»', nombre: 'Zambomba «Arcos-Jerez»', city: 'Arcos de la Frontera', ubicacion: 'Arcos de la Frontera', lugar: 'Paseo de Andalucía', provincia: 'Cádiz', fechaLocal: '2026-12-19', horaLocal: '16:00', sesionId: '2026-12-19/16:00', negocioId: 'biz_arcos', fuentes: [{ url: 'https://arcosdelafrontera.es/navidad' }] };
const OTRO = { titulo: 'Cabalgata de Navidad', city: 'Arcos de la Frontera', fechaLocal: '2026-12-20', horaLocal: '18:00', negocioId: 'biz_arcos', fuentes: [] };
const LEJOS = { titulo: 'Zambomba de Jerez', city: 'Jerez de la Frontera', fechaLocal: '2026-12-19', horaLocal: '16:00', negocioId: 'biz_jerez', fuentes: [] };
const store = () => {
  const docs = [['ev_zambomba', ZAMBOMBA], ['ev_cabalgata', OTRO], ['ev_jerez', LEJOS]].map(([id, data]) => ({ id, data, updateTime: '1' })).sort((a, b) => (a.id < b.id ? -1 : 1));
  return { async get(c) { return c === 'amalia_catalog_guard' ? { id: 'eventos', data: { epoch: 1 }, updateTime: 'g1' } : null; }, async list(c, { cursor, limit = 500 } = {}) { return c !== 'eventos' ? [] : docs.filter(r => !cursor || r.id > cursor).slice(0, limit); } };
};
const p = { id: 'x', actions: ['read'], businesses: ['*'] };
const buscar = q => new EventService(store(), {}, { warm: false }).findDuplicates(q, p);
const ids = r => [...r.coincidencias, ...r.informativas].map(x => x.eventId).sort();

test('Zambomba en Arcos: con título, city, municipio y rango (sin fechaLocal) la encuentra', async () => {
  const r = await buscar({ titulo: 'Zambomba «Arcos-Jerez»', city: 'Arcos de la Frontera', municipio: 'Arcos de la Frontera', desde: '2026-12-01', hasta: '2026-12-31' });
  assert.equal(r.modo, 'titulo'); assert.equal(r.exhaustivo, true); assert.deepEqual(ids(r), ['ev_zambomba']);
  assert.deepEqual(r.informativas[0].motivos, ['titulo']); assert.equal(r.coincidencias.length, 0, 'sin fecha no bloquea');
});
test('Zambomba: título sin signos o abreviado también aparece (sin fecha y con fecha), sin bloquear', async () => {
  assert.deepEqual(ids(await buscar({ titulo: 'Zambomba Arcos Jerez', municipio: 'arcos de la frontera' })), ['ev_zambomba']);
  assert.deepEqual(ids(await buscar({ titulo: 'Zambomba', city: 'Arcos de la Frontera' })), ['ev_zambomba'], 'no mezcla la de Jerez');
  const r = await buscar({ titulo: 'Zambomba', city: 'Arcos de la Frontera', fechaLocal: '2026-12-19' });
  const z = [...r.informativas].find(x => x.eventId === 'ev_zambomba'); assert.ok(z.motivos.includes('titulo_parcial')); assert.equal(r.coincidencias.length, 0);
});
test('solo municipio o rango: lista lo que cumple los filtros en vez de devolver 0', async () => {
  const r = await buscar({ municipio: 'Arcos de la Frontera' });
  assert.equal(r.modo, 'listado'); assert.deepEqual(ids(r), ['ev_cabalgata', 'ev_zambomba']); assert.equal(r.filtroTotal, 2); assert.equal(r.listadoTruncado, false);
  assert.deepEqual(ids(await buscar({ municipio: 'Arcos de la Frontera', desde: '2026-12-19', hasta: '2026-12-19' })), ['ev_zambomba']);
  assert.deepEqual(ids(await buscar({ city: 'Árcos de la Fróntera' })), ['ev_cabalgata', 'ev_zambomba'], 'las tildes no importan');
});
test('con fechaLocal el comportamiento de siempre: nombre+fecha+lugar+hora bloquea', async () => {
  const r = await buscar({ titulo: 'Zambomba «Arcos-Jerez»', city: 'Arcos de la Frontera', lugar: 'Paseo de Andalucía', fechaLocal: '2026-12-19', horaLocal: '16:00' });
  assert.equal(r.modo, 'duplicado'); assert.equal(r.coincidencias[0].eventId, 'ev_zambomba');
});
test('una búsqueda sin ningún criterio se rechaza en vez de decir 0', async () => {
  await assert.rejects(buscar({}), e => e.code === 'busqueda_vacia');
});

const fuente = extra => { const identificador = 'hayzambomba.es', id = `fte_web_${hash(identificador).slice(0, 24)}`; return { id, updateTime: '2026-11-22T16:06:52Z', data: { id, canal: 'web', identificador, url: 'https://hayzambomba.es', estado: 'activa', origen: 'asistente', negocio_id: null, municipio: null, ...extra } }; };
test('fuente de ámbito regional sin municipio (hayzambomba.es) es válida; sin ningún ámbito sigue rechazada', () => {
  const s = registrySnapshot(fuente({ region: 'Andalucía' }));
  assert.equal(s.municipio, null); assert.equal(s.region, 'Andalucía');
  assert.equal(registrySnapshot(fuente({ provincia: 'Cádiz' })).provincia, 'Cádiz');
  assert.ok(registrySnapshot(fuente({ ambito: 'nacional' })));
  assert.throws(() => registrySnapshot(fuente({})), e => e.code === 'registro_source_identity_invalid' && e.details.campo === 'municipio');
  assert.throws(() => registrySnapshot(fuente({ region: 'Andalucía', url: 'https://otra.es' })), e => e.code === 'registro_source_identity_invalid', 'la identidad sigue comprobándose');
});
