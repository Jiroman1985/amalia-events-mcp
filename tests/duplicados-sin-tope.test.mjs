import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';
import { FirestoreStore, camposIndiceFuentes } from '../firestore-store.mjs';

const P = { id: 'x', actions: ['read'], businesses: ['*'] };
const URL_F = 'https://agenda.example/programa';
const doc = i => ({ negocioId: 'b' + (i % 7), titulo: 'Relleno ' + i, city: 'Ciudad ' + (i % 40), fechaLocal: '2027-0' + (1 + (i % 8)) + '-10', horaLocal: '10:00', fuentes: [] });
const idN = i => 'ev_' + String(i).padStart(6, '0');
const DUP = { negocioId: 'bz', titulo: 'Belén viviente', city: 'Torremolinos', fechaLocal: '2027-12-20', horaLocal: '18:00', fuentes: [] };
const BUSCA = { titulo: 'Belén viviente', city: 'Torremolinos', fechaLocal: '2027-12-20' };

// Doble con las consultas de Firestore. prohibirBarrido: listar `eventos` sin filtro es un error.
class Store {
  constructor(n, extra = [], { prohibirBarrido = false, marca = false, guardMueve = false, lento = 0 } = {}) {
    this.docs = [...Array.from({ length: n }, (_, i) => [idN(i), doc(i)]), ...extra].map(([id, data]) => ({ id, data: { ...data, ...camposIndiceFuentes(data) }, updateTime: '1' })).sort((a, b) => (a.id < b.id ? -1 : 1));
    Object.assign(this, { prohibirBarrido, marca, guardMueve, lento, g: 0, campos: null });
  }
  async get(c, id) {
    if (c === 'amalia_catalog_guard') return id === 'indice_urls' ? (this.marca ? { id, data: { completo: true }, updateTime: '1' } : null) : { id, data: { epoch: 1 }, updateTime: 'g' + (this.guardMueve ? this.g++ : 1) };
    return null;
  }
  async list(c, { cursor, limit = 500, eq, contiene, fields } = {}) {
    if (c !== 'eventos') return [];
    if (!eq && !contiene && this.prohibirBarrido) throw new Error('full_scan_forbidden');
    if (this.lento) await new Promise(r => setTimeout(r, this.lento));
    this.campos = fields || this.campos;
    let rows = this.docs;
    for (const [k, v] of Object.entries(eq || {})) rows = rows.filter(r => r.data[k] === v);
    for (const [k, v] of Object.entries(contiene || {})) rows = rows.filter(r => (r.data[k] || []).includes(v));
    const desde = cursor ? rows.findIndex(r => r.id > cursor) : 0;
    return desde < 0 ? [] : rows.slice(desde, desde + limit);
  }
  async queryRango(c, campo, a, b) { return this.docs.filter(r => typeof r.data[campo] === 'string' && r.data[campo] >= a && r.data[campo] <= b); }
}
const servicio = (store, o = {}) => new EventService(store, {}, { warm: false, ...o });
const todos = r => [...r.coincidencias, ...r.informativas].map(x => x.eventId).sort();
const con12000 = (o, extra = []) => new Store(12000, [[idN(11500) + 'x', DUP], ...extra], o);

test('12.000 eventos con ruta indexada: exhaustivo, encuentra el duplicado y no recorre el catálogo', async () => {
  const r = await servicio(con12000({ prohibirBarrido: true, marca: true }), { dupIndexado: true }).findDuplicates(BUSCA, P);
  assert.equal(r.estrategia, 'indexada'); assert.equal(r.alcance.estrategia, 'indexada'); assert.equal(r.exhaustivo, true);
  assert.equal(r.coincidencias[0].eventId, idN(11500) + 'x'); assert.ok(r.escaneados < 100);
  assert.ok(r.alcance.consultas.some(c => c.consulta === 'fechaLocal'));
});
test('ruta indexada: URL de fuente en otra fecha, URL solo en fuentes[], sourceId, sesión y legacy dan lo mismo que el barrido', async () => {
  const extra = [
    ['ev_url', { titulo: 'Otra cosa', city: 'Vigo', fechaLocal: '2028-01-01', fuentes: [{ url: URL_F }] }],
    ['ev_sid', { titulo: 'Otra más', city: 'Lugo', fechaLocal: '2028-02-01', fuentes: [{ url: 'https://z.example', sourceId: 'prog-9' }] }],
    ['ev_legacy', { nombre: 'Belén viviente', ciudad: 'Torremolinos', fecha_inicio: '2027-12-20' }],
    ['ev_dt', { nombre: 'Belén viviente', ciudad: 'Torremolinos', dateTime: '2027-12-20T18:00:00+01:00' }],
    ['ev_ses', { titulo: 'Taller', city: 'Ourense', fechaLocal: '2028-03-01', sesionId: '2027-12-20/sin-hora' }]
  ];
  const q = { ...BUSCA, urls: [URL_F], sourceIds: ['prog-9'] };
  const idx = await servicio(con12000({ prohibirBarrido: true, marca: true }, extra), { dupIndexado: true }).findDuplicates(q, P);
  const barrido = await servicio(con12000({}, extra)).findDuplicates(q, P);
  for (const id of ['ev_url', 'ev_sid', 'ev_legacy', 'ev_dt', 'ev_ses']) assert.ok(todos(idx).includes(id), id);
  const resumen = r => [...r.coincidencias, ...r.informativas].map(x => x.eventId + ':' + [...x.motivos].sort()).sort();
  assert.deepEqual(resumen(idx), resumen(barrido));
});
test('sin marca de relleno, sin activar o sin fecha, se usa el barrido', async () => {
  for (const [o, s] of [[{ dupIndexado: true }, {}], [{ dupIndexado: false }, { marca: true }]]) {
    const r = await servicio(con12000(s), o).findDuplicates(BUSCA, P);
    assert.equal(r.estrategia, 'barrido'); assert.equal(r.exhaustivo, true); assert.equal(r.escaneados, 12001);
  }
  const t = await servicio(con12000({ marca: true }), { dupIndexado: true }).findDuplicates({ titulo: 'Belén viviente', city: 'Torremolinos' }, P);
  assert.equal(t.modo, 'titulo'); assert.equal(t.estrategia, 'barrido'); assert.equal(t.exhaustivo, true); assert.equal(t.escaneados, 12001); assert.ok(todos(t).includes(idN(11500) + 'x'));
});
test('barrido: pide solo los campos de las reglas; limite=5000 (máximo antiguo) ya no recorta', async () => {
  const store = con12000({});
  const r = await servicio(store).findDuplicates({ ...BUSCA, limite: 5000 }, P);
  assert.equal(r.exhaustivo, true); assert.equal(r.escaneados, 12001); assert.ok(store.campos.includes('titulo') && !store.campos.includes('descripcion'));
});
test('catálogo de exactamente limite documentos: exhaustivo; limite menor: limite_alcanzado', async () => {
  const justo = await servicio(new Store(1000)).findDuplicates({ ...BUSCA, limite: 1000 }, P);
  assert.equal(justo.exhaustivo, true); assert.equal(justo.escaneados, 1000);
  const corto = await servicio(new Store(1001)).findDuplicates({ ...BUSCA, limite: 1000 }, P);
  assert.equal(corto.exhaustivo, false); assert.equal(corto.motivoParcial, 'limite_alcanzado');
});
test('plazo agotado: parcial, nunca exhaustivo', async () => {
  const r = await servicio(new Store(3000, [], { lento: 30 }), { dupPlazoMs: 50 }).findDuplicates(BUSCA, P);
  assert.equal(r.exhaustivo, false); assert.equal(r.motivoParcial, 'plazo_agotado'); assert.ok(r.escaneados < 3000);
});
test('si la guardia sigue moviéndose, no es exhaustivo (barrido e indexada)', async () => {
  for (const o of [{ dupIndexado: false }, { dupIndexado: true }]) {
    const r = await servicio(new Store(100, [], { guardMueve: true, marca: true }), o).findDuplicates(BUSCA, P);
    assert.equal(r.exhaustivo, false); assert.equal(r.motivoParcial, 'catalogo_modificado_durante_lectura');
  }
});
test('almacén: consulta array-contains y proyección; escribe los campos derivados solo si está activado', async () => {
  const cuerpos = [];
  const fetchImpl = async (u, o) => { cuerpos.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => (String(u).includes(':commit') ? { writeResults: [{ updateTime: '2' }] } : []) }; };
  const st = new FirestoreStore({ project: 'p', fetchImpl, indiceUrls: true });
  await st.list('eventos', { contiene: { urlsFuente: URL_F }, fields: ['titulo'] });
  assert.equal(cuerpos[0].structuredQuery.where.fieldFilter.op, 'ARRAY_CONTAINS'); assert.deepEqual(cuerpos[0].structuredQuery.select, { fields: [{ fieldPath: 'titulo' }] });
  await st.write('eventos', 'e1', { fuentes: [{ url: URL_F }] }, { updateTime: '1', updateFields: ['fuentes'] });
  assert.deepEqual(cuerpos[1].writes[0].updateMask.fieldPaths, ['fuentes', 'urlsFuente', 'sourceIdsFuente']);
  const off = new FirestoreStore({ project: 'p', fetchImpl, indiceUrls: false });
  await off.write('eventos', 'e1', { fuentes: [{ url: URL_F }] }, { updateTime: '1' });
  assert.equal(cuerpos[2].writes[0].update.fields.urlsFuente, undefined);
});
