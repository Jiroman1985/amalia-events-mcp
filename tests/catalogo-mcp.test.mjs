import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { DomainError, canonicalInput, record, geoCampos, GeoPunto, CATEGORIAS_OFICIALES } from '../event-domain.mjs';
import { toFirestoreFields } from '../event-record.mjs';
import { HistoricalFixtureService as EventService } from './helpers/historical-fixtures.mjs';
import { CatalogoService, resumen } from '../catalogo-service.mjs';
import { createApp } from '../server-v2.mjs';
import { decodeValue } from '../firestore-store.mjs';
import { calcularCatalogo } from '../catalogo-compartido.mjs';
import { hash } from '../event-domain.mjs';

const owner = { id: 'conchi-owner', actions: ['*'], businesses: ['*'] };
const editorA = { id: 'editor-a', actions: ['read', 'create', 'edit'], businesses: ['bizA'] };

const base = (o = {}) => ({
  negocioId: 'bizA', titulo: 'Concierto de ensayo', descripcion: 'Evento de ensayo.', city: 'Málaga', provincia: 'Provincia de prueba', fechaLocal: '2099-05-10', horaLocal: null,
  timeZone: 'Europe/Madrid', sesionId: 'ensayo-1', fuentes: [{ url: 'https://example.org/e', checkedAt: '2026-11-01T10:00:00.000Z' }], prueba: true, ...o,
});

/** Imita Firestore: updateTime por documento, precondiciones, máscara de campos y paginación por id. */
class MemoryStore {
  constructor() { this.rows = new Map([['negocios/bizA', { data: { nombre: 'A' }, updateTime: '1' }]]); this.seq = 1; this.writes = []; }
  async get(c, id) { const r = this.rows.get(`${c}/${id}`); return r ? { id, ...structuredClone(r) } : null; }
  async list(c, { limit = 50, cursor = null } = {}) {
    const todos = [...this.rows].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.split('/').at(-1), ...structuredClone(r) })).sort((a, b) => (a.id < b.id ? -1 : 1));
    return todos.filter((r) => !cursor || r.id > cursor).slice(0, limit);
  }
  async write(c, id, data, { updateTime, create, updateFields } = {}) {
    const key = `${c}/${id}`, cur = this.rows.get(key);
    if ((create && cur) || (!create && cur?.updateTime !== updateTime)) throw new DomainError('version_conflict');
    let next = structuredClone(data);
    if (updateFields && cur) { next = structuredClone(cur.data); for (const f of updateFields) { if (f in data) next[f] = structuredClone(data[f]); else delete next[f]; } }
    const r = { data: next, updateTime: String(++this.seq) };
    this.rows.set(key, r); this.writes.push({ c, id, fields: updateFields || null });
    return { id, ...r };
  }
  async revisions() { return []; }
  seed(id, data) { this.rows.set(`eventos/${id}`, { data, updateTime: String(++this.seq) }); }
  touch(c, id) { this.rows.get(`${c}/${id}`).updateTime = String(++this.seq); }
}

// ─────────────────────────── categorías ───────────────────────────

test('categorías: acepta las 8 oficiales, ids y nombres v1, y conserva el valor original', () => {
  assert.equal(CATEGORIAS_OFICIALES.length, 8);
  const e = canonicalInput(base({ categorias: ['Cultura', 'Música y festivales'] }));
  assert.deepEqual(e.categorias, ['Cultura', 'Música y festivales']); // original intacto
  assert.deepEqual(e.categoriaIds, ['entretenimiento_y_cultura']);   // equivalencia canónica, sin duplicar
  assert.deepEqual(e.categoriaRevision, []);
  const oficial = canonicalInput(base({ categorias: ['Experiencias gastronómicas', 'business'] }));
  assert.deepEqual(oficial.categoriaIds, ['experiencias_gastronomicas', 'business']);
});

test('categorías: una desconocida sigue fallando y una ambigua se acepta marcada para revisión', () => {
  assert.throws(() => canonicalInput(base({ categorias: ['Inventada'] })), /unknown_category/);
  const e = canonicalInput(base({ categorias: ['Fiestas locales'] }));
  assert.deepEqual(e.categoriaIds, []);
  assert.equal(e.categoriaRevision[0].motivo, 'ambigua');
  assert.deepEqual(e.categoriaRevision[0].alternativas, ['eventos_de_temporada', 'entretenimiento_y_cultura']);
  // `categoria` suelta no se valida (como antes) pero queda marcada si no equivale a nada
  assert.equal(canonicalInput(base({ categoria: 'ocio raro' })).categoriaRevision[0].motivo, 'desconocida');
});

// ─────────────────────────── coordenadas ───────────────────────────

const geo = (o = {}) => ({ lat: 36.7213, lng: -4.4214, tipo: 'recinto', fuente: 'web oficial del recinto', ...o });

test('coordenadas: recinto, dirección aproximada y municipio guardan lo que lee la web', () => {
  const e = canonicalInput(base({ lugar: 'Teatro Cervantes', geoUbicacion: geo() }));
  const r = record(e, owner);
  assert.ok(r.geo instanceof GeoPunto);
  assert.deepEqual([r.geo.latitude, r.geo.longitude, r.geo_precision, r.geo_fuente, r.lat, r.lng], [36.7213, -4.4214, 'lugar', 'web oficial del recinto', null, null]);
  assert.equal(r.geoUbicacion.tipo, 'recinto');
  assert.ok(Date.parse(r.geoUbicacion.comprobadoEn));

  const dir = record(canonicalInput(base({ geoUbicacion: geo({ tipo: 'direccion_aproximada' }) })), owner);
  assert.deepEqual([dir.geo, dir.geo_precision, dir.lat, dir.lng], [null, null, 36.7213, -4.4214]);

  const mun = record(canonicalInput(base({ geoUbicacion: geo({ tipo: 'municipio' }) })), owner);
  assert.deepEqual([mun.geo_precision, mun.lat], ['ciudad', null]);
});

test('coordenadas: valida números, rangos, (0, 0), tipo, fuente y nombre del recinto; permite un cero real', () => {
  const malo = (g, lugar) => canonicalInput(base({ lugar, geoUbicacion: g }));
  assert.throws(() => malo(geo({ lat: 0, lng: 0 }), 'Sala'), /invalid_coordinates/);
  assert.throws(() => malo(geo({ lat: NaN }), 'Sala'), /invalid_coordinates/);
  assert.throws(() => malo(geo({ lat: 95 }), 'Sala'), /invalid_coordinates/);
  assert.throws(() => malo(geo({ lng: 181 }), 'Sala'), /invalid_coordinates/);
  assert.throws(() => malo(geo({ tipo: undefined }), 'Sala'), /location_type_required/);
  assert.throws(() => malo(geo({ tipo: 'exacta' }), 'Sala'), /location_type_required/);
  assert.throws(() => malo(geo({ fuente: '' }), 'Sala'), /location_source_required/);
  assert.throws(() => malo(geo(), undefined), /venue_name_required/);        // recinto sin nombre de lugar
  assert.throws(() => malo(geo(), 'Málaga'), /venue_name_required/);         // el lugar es solo el municipio
  assert.throws(() => malo(geo({ comprobadoEn: '2999-01-01T00:00:00Z' }), 'Sala'), /invalid_location_checkedAt/);
  assert.equal(malo(geo({ lat: 39.9, lng: 0 }), 'Sala').geoUbicacion.lng, 0); // Greenwich: un cero suelto es real
});

test('coordenadas: canonicalInput es determinista aunque pase el tiempo (la admisión lo calcula dos veces)', async () => {
  const entrada = base({ lugar: 'Sala', geoUbicacion: geo() });
  const a = canonicalInput(entrada);
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(canonicalInput(entrada), a);
  assert.match(a.geoUbicacion.comprobadoEn, /^\d{4}-\d{2}-\d{2}$/); // por omisión, solo el día
  assert.equal(canonicalInput(base({ lugar: 'Sala', geoUbicacion: geo({ comprobadoEn: '2026-11-02T10:00:00+01:00' }) })).geoUbicacion.comprobadoEn, '2026-11-02T09:00:00.000Z');
});

test('coordenadas: el codificador de Firestore escribe un GeoPoint de verdad', () => {
  const f = toFirestoreFields(geoCampos({ lat: 1.5, lng: -2.5, tipo: 'recinto', fuente: 'x y z' }));
  assert.deepEqual(f.geo, { geoPointValue: { latitude: 1.5, longitude: -2.5 } });
  assert.deepEqual(f.lat, { nullValue: null });
});

// ─────────────────────────── edición ───────────────────────────

async function conEvento(extra = {}) {
  const store = new MemoryStore(), events = new EventService(store, {});
  const e = await events.create(base(extra), owner);
  return { store, events, e };
}

test('editar: cambiar el precio no reescribe categorías antiguas ni coordenadas', async () => {
  const { store, events, e } = await conEvento({ categorias: ['Fiestas locales'] });
  const antes = structuredClone(store.rows.get('eventos/' + e.eventId).data);
  const r = await events.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 1, changes: { precio: 12 }, reason: 'Precio confirmado' }, editorA);
  assert.equal(r.version, 2);
  const despues = store.rows.get('eventos/' + e.eventId).data;
  assert.deepEqual(despues.categorias, antes.categorias);
  assert.deepEqual(despues.categoriaRevision, antes.categoriaRevision);
  assert.equal(despues.geo ?? null, antes.geo ?? null);
});

test('editar: geoUbicacion se puede añadir con control de versión, y ubicacion/lugar siguen siendo identidad', async () => {
  const { store, events, e } = await conEvento({ lugar: 'Teatro Cervantes' });
  await assert.rejects(events.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 0, changes: { geoUbicacion: geo() }, reason: 'Añadir ubicación' }, editorA), /version_conflict/);
  const r = await events.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 1, changes: { geoUbicacion: geo() }, reason: 'Añadir ubicación' }, editorA);
  assert.equal(r.version, 2);
  const d = store.rows.get('eventos/' + e.eventId).data;
  assert.deepEqual([d.geo_precision, d.geoUbicacion.tipo, d.geoUbicacion.fuente], ['lugar', 'recinto', 'web oficial del recinto']);
  await assert.rejects(events.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 2, changes: { lugar: 'Otro sitio' }, reason: 'Cambio de lugar' }, editorA), /evidence_required/);
  await assert.rejects(events.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 2, changes: { ubicacion: { municipio: 'Málaga' } }, reason: 'x' }, editorA), /immutable_event_identity/);
  // una segunda edición cualquiera conserva las coordenadas y su fecha de comprobación
  const comprobado = d.geoUbicacion.comprobadoEn;
  await events.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 2, changes: { precio: 5 }, reason: 'Precio' }, editorA);
  assert.equal(store.rows.get('eventos/' + e.eventId).data.geoUbicacion.comprobadoEn, comprobado);
});

test('editar: cambiar el tipo de ubicación limpia los campos del tipo anterior', async () => {
  const { store, events, e } = await conEvento({ lugar: 'Teatro Cervantes', geoUbicacion: geo() });
  await events.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 1, changes: { geoUbicacion: geo({ tipo: 'direccion_aproximada' }) }, reason: 'No se pudo confirmar el recinto' }, editorA);
  const d = store.rows.get('eventos/' + e.eventId).data;
  assert.deepEqual([d.geo, d.geo_precision, d.lat, d.lng], [null, null, 36.7213, -4.4214]);
});

// ─────────────────────────── clasificar_catalogo ───────────────────────────

function catalogo() {
  const store = new MemoryStore();
  const manana = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  store.seed('a1', { nombre: 'Concierto en Sala X', categoria: 'musica', fecha_inicio: manana, ubicacion: { latitude: 36.7, longitude: -4.4 }, place: 'Sala X', city: 'Málaga', activa: true });
  store.seed('a2', { nombre: 'Clase de surf', categoria: 'ocio', fecha_inicio: manana, lat: 36.5, lng: -4.6, source: 'fever', ciudad: 'Marbella' });
  store.seed('a3', { nombre: 'Algo raro', categoria: 'ocio', fecha_inicio: manana, lat: 0, lng: 0, source: 'fever' });
  store.seed('a4', { nombre: 'Retirado', categoria: 'musica', retirado: true, activa: false, estado: 'retirado' });
  const svc = new CatalogoService(store, { pausaMs: 0 });
  return { store, svc };
}

test('clasificar: solo propietarios; simular no escribe nada y no toca ningún campo original', async () => {
  const { store, svc } = catalogo();
  await assert.rejects(svc.classify({}, editorA), /forbidden/);
  const antes = structuredClone([...store.rows]);
  const r = await svc.classify({}, owner);
  assert.equal(r.modo, 'simular');
  assert.equal(r.totales.documentos, 4);
  assert.equal(r.totales.retirados, 1);
  assert.equal(r.totales.aCambiar, 3);
  assert.equal(r.categorias.entretenimiento_y_cultura, 1);
  assert.equal(r.categorias.aventura_deporte_y_naturaleza, 1);   // «ocio» + título «surf» resuelto
  assert.equal(r.categorias.REVISION, 1);                          // el ambiguo queda en revisión, no en Cultura
  assert.equal(r.pendientesRevision.categoria.total, 1);
  assert.deepEqual([...store.rows], antes);
});

test('clasificar: aplicar exige runId y el código del lote; rechaza si los datos cambiaron', async () => {
  const { store, svc } = catalogo();
  const sim = await svc.classify({}, owner);
  await assert.rejects(svc.classify({ modo: 'aplicar', codigoConfirmacion: sim.lote.codigoConfirmacion }, owner), /run_id_required/);
  await assert.rejects(svc.classify({ modo: 'aplicar', runId: 'tanda-001', codigoConfirmacion: '0'.repeat(12) }, owner), /confirmation_mismatch/);
  store.touch('eventos', 'a1'); // alguien edita entre la simulación y la aplicación
  await assert.rejects(svc.classify({ modo: 'aplicar', runId: 'tanda-001', codigoConfirmacion: sim.lote.codigoConfirmacion }, owner), /confirmation_mismatch/);
  assert.equal(store.writes.length, 0);
});

test('clasificar: aplica solo la capa derivada, guarda el registro de cambios y es idempotente', async () => {
  const { store, svc } = catalogo();
  const originales = Object.fromEntries([...store.rows].filter(([k]) => k.startsWith('eventos/')).map(([k, r]) => [k, structuredClone(r.data)]));
  const sim = await svc.classify({}, owner);
  const r = await svc.classify({ modo: 'aplicar', runId: 'tanda-001', codigoConfirmacion: sim.lote.codigoConfirmacion }, owner);
  assert.deepEqual([r.aplicados, r.conflictos, r.restantes], [3, 0, 0]);
  for (const [k, antes] of Object.entries(originales)) {
    const ahora = store.rows.get(k).data;
    if (antes.retirado) { assert.deepEqual(ahora, antes); continue; }  // un retirado no se toca
    const { catalogo_amalia_v1: capa, ...resto } = ahora;
    assert.deepEqual(resto, antes, 'ningún campo original cambia: ' + k);
    assert.equal(capa.version, 1);
  }
  assert.ok(store.writes.filter((w) => w.c === 'eventos').every((w) => w.fields.length === 1 && w.fields[0] === 'catalogo_amalia_v1'));
  const log = store.rows.get('eventos_catalogo_cambios/tanda-001__a1').data;
  assert.deepEqual([log.por, log.antes, typeof log.despues.categoria.estado], ['conchi-owner', null, 'string']);
  assert.equal(store.rows.get('eventos_catalogo_runs/tanda-001').data.aplicados, 3);
  // segunda pasada: todo al día, nada que escribir
  const otra = await svc.classify({}, owner);
  assert.equal(otra.totales.aCambiar, 0);
  const nWrites = store.writes.length;
  await svc.classify({ modo: 'aplicar', runId: 'tanda-002', codigoConfirmacion: otra.lote.codigoConfirmacion }, owner);
  assert.equal(store.writes.length, nWrites);
});

test('clasificar: se reanuda por lotes pequeños sin duplicar ni perder nada', async () => {
  const { store, svc } = catalogo();
  let restantes = Infinity, vueltas = 0;
  while (restantes > 0 && vueltas++ < 10) {
    const sim = await svc.classify({ limite: 1 }, owner);
    if (!sim.lote.tamano) break;
    const r = await svc.classify({ modo: 'aplicar', runId: 'tanda-lotes', limite: 1, codigoConfirmacion: sim.lote.codigoConfirmacion }, owner);
    restantes = r.restantes;
  }
  assert.equal(vueltas, 3);
  assert.equal([...store.rows.keys()].filter((k) => k.startsWith('eventos_catalogo_cambios/')).length, 3);
  assert.equal(store.rows.get('eventos_catalogo_runs/tanda-lotes').data.tandas, 3);
  assert.equal((await svc.classify({}, owner)).totales.aCambiar, 0);
});

test('clasificar: un cambio concurrente en un evento se cuenta como conflicto y no se pisa', async () => {
  const { store, svc } = catalogo();
  const sim = await svc.classify({}, owner);
  const original = store.write.bind(store);
  store.write = async (c, id, data, o) => { if (c === 'eventos' && id === 'a2') store.touch('eventos', 'a2'); return original(c, id, data, o); };
  const r = await svc.classify({ modo: 'aplicar', runId: 'tanda-001', codigoConfirmacion: sim.lote.codigoConfirmacion }, owner);
  assert.deepEqual([r.aplicados, r.conflictos], [2, 1]);
  assert.equal(store.rows.get('eventos/a2').data.catalogo_amalia_v1, undefined);
});

// ─────────────────────────── revisar_catalogo ───────────────────────────

test('revisar: resuelve a mano categoría y ubicación, manda sobre lo automático y queda registrado', async () => {
  const { store, svc } = catalogo();
  await assert.rejects(svc.review({ eventId: 'a3', categoria: 'business', motivo: 'ok' }, editorA), /forbidden/);
  await assert.rejects(svc.review({ eventId: 'a3', categoria: 'business', motivo: 'x' }, owner), /reason_required/);
  await assert.rejects(svc.review({ eventId: 'a3', categoria: 'Inventada', motivo: 'Es una reunión' }, owner), /unknown_category/);
  await assert.rejects(svc.review({ eventId: 'a3', ubicacion: { lat: 0, lng: 0, tipo: 'recinto', fuente: 'visita' }, motivo: 'Visitado' }, owner), /invalid_coordinates/);
  await assert.rejects(svc.review({ eventId: 'a4', categoria: 'business', motivo: 'Ya retirado' }, owner), /event_retired/);
  const r = await svc.review({ eventId: 'a3', categoria: 'Negocios y networking', ubicacion: { lat: 36.7213, lng: -4.4214, tipo: 'recinto', fuente: 'visita del equipo' }, motivo: 'Confirmado con el organizador' }, owner);
  assert.deepEqual([r.catalogo.categoria.id, r.catalogo.ubicacion.tipo, r.catalogo.ubicacion.verificacion], ['business', 'recinto', 'verificada']);
  const d = store.rows.get('eventos/a3').data;
  assert.equal(d.categoria, 'ocio');                  // el original no se toca
  assert.deepEqual([d.catalogo_revision.por, d.catalogo_revision.categoria], ['conchi-owner', 'business']);
  assert.ok([...store.rows.keys()].some((k) => k.startsWith('eventos_catalogo_cambios/rev__a3__')));
  // y la siguiente clasificación completa la respeta
  const sim = await svc.classify({}, owner);
  await svc.classify({ modo: 'aplicar', runId: 'tanda-003', codigoConfirmacion: sim.lote.codigoConfirmacion }, owner);
  assert.equal(store.rows.get('eventos/a3').data.catalogo_amalia_v1.categoria.id, 'business');
});

test('resumen: ignora la marca de tiempo del cálculo', () => {
  assert.equal(resumen(null), null);
});

test('catalogo-compartido.mjs es un módulo generado y lleva la huella de su fuente', () => {
  const cabecera = readFileSync(new URL('../catalogo-compartido.mjs', import.meta.url), 'utf8').split('\n')[0];
  assert.match(cabecera, /^\/\/ GENERADO desde amalia-vibrant-journeys\/netlify\/functions-v2\/lib\/catalogo \(huella de la fuente: [0-9a-f]{16}\)/);
});

// ─────────────────────────── permisos ───────────────────────────
// Las cuentas reales del servidor (4-nov-2026): conchi-owner y lola-operator globales con '*'; hermes-ingestor global pero
// solo create_business/admit/read; hermes-public-reader solo lectura pública. Más una cuenta '*' limitada a un negocio.
const lola = { id: 'lola-operator', actions: ['*'], businesses: ['*'] };
const ingestor = { id: 'hermes-ingestor', actions: ['create_business', 'admit', 'read'], businesses: ['*'] };
const lectorPublico = { id: 'hermes-public-reader', actions: ['read_public'], businesses: [] };
const duenoDeUnNegocio = { id: 'owner-bizA', actions: ['*'], businesses: ['bizA'] };

const sinPermiso = (p) => async (fn) => assert.rejects(fn(p), /forbidden/);

test('permisos: clasificar y revisar exigen acción * Y cuenta global; nada se escribe si se deniega', async () => {
  const { store, svc } = catalogo();
  const antes = structuredClone([...store.rows]);
  for (const p of [editorA, ingestor, lectorPublico, duenoDeUnNegocio]) {
    await assert.rejects(svc.classify({}, p), /forbidden/, 'clasificar ' + p.id);
    await assert.rejects(svc.classify({ modo: 'aplicar', runId: 'tanda-001', codigoConfirmacion: 'x' }, p), /forbidden/, 'aplicar ' + p.id);
    await assert.rejects(svc.review({ eventId: 'a1', categoria: 'business', motivo: 'Prueba de permisos' }, p), /forbidden/, 'revisar ' + p.id);
  }
  assert.deepEqual([...store.rows], antes);
  await svc.classify({}, owner); await svc.classify({}, lola); // las dos cuentas globales sí pueden
});

test('permisos: una cuenta «*» limitada a un negocio recibe business_forbidden (no opera sobre todo el catálogo)', async () => {
  const { svc } = catalogo();
  await assert.rejects(svc.classify({}, duenoDeUnNegocio), /business_forbidden/);
  await assert.rejects(svc.review({ eventId: 'a1', categoria: 'business', motivo: 'Prueba' }, duenoDeUnNegocio), /business_forbidden/);
  await assert.rejects(svc.pending({}, duenoDeUnNegocio), /business_forbidden/);
  await assert.rejects(svc.pending({}, editorA), /business_forbidden/);
});

test('permisos: pendientes es de solo lectura global: lo ve el ingestor, no el lector público', async () => {
  const { svc } = catalogo();
  assert.ok((await svc.pending({}, ingestor)).total >= 0);
  await assert.rejects(svc.pending({}, lectorPublico), /forbidden/);
});

test('permisos (HTTP/MCP): cada herramienta nueva responde según la cuenta que llama', async () => {
  const { store } = catalogo();
  const reg = [owner, lola, ingestor, lectorPublico, duenoDeUnNegocio, editorA].map((p) => ({ ...p, tokenHash: hash('tok-' + p.id) }));
  const app = createApp({ store, events: {}, media: {}, editorial: { pausedNow: () => true }, publicBase: 'https://example.org' }, reg);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  const llamar = async (cuenta, name, args) => (await (await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer tok-' + cuenta }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  try {
    const ok = (r) => { assert.notEqual(r.isError, true, JSON.stringify(r.structuredContent)); return r.structuredContent.result; };
    const error = (r) => { assert.equal(r.isError, true); return r.structuredContent.result.error; };
    assert.equal(ok(await llamar('conchi-owner', 'clasificar_catalogo', {})).modo, 'simular');
    assert.equal(ok(await llamar('lola-operator', 'clasificar_catalogo', {})).modo, 'simular');
    for (const c of ['hermes-ingestor', 'hermes-public-reader', 'editor-a']) assert.equal(error(await llamar(c, 'clasificar_catalogo', {})), 'forbidden', c);
    assert.equal(error(await llamar('owner-bizA', 'clasificar_catalogo', {})), 'business_forbidden');
    assert.equal(error(await llamar('hermes-ingestor', 'revisar_catalogo', { eventId: 'a3', categoria: 'business', motivo: 'Prueba' })), 'forbidden');
    assert.equal(error(await llamar('owner-bizA', 'revisar_catalogo', { eventId: 'a3', categoria: 'business', motivo: 'Prueba' })), 'business_forbidden');
    assert.ok(ok(await llamar('hermes-ingestor', 'pendientes_catalogo', {})).total >= 0);
    assert.equal(error(await llamar('hermes-public-reader', 'pendientes_catalogo', {})), 'forbidden');
    assert.equal(error(await llamar('owner-bizA', 'pendientes_catalogo', {})), 'business_forbidden');
  } finally { app.closeAllConnections(); await new Promise((r) => app.close(r)); }
});

// ─────────────────────────── pendientes ───────────────────────────

function conPendientes() {
  const store = new MemoryStore();
  const dia = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const base = { categoria: 'musica', city: 'Málaga' };
  store.seed('sin-ubicacion', { ...base, nombre: 'Sin ubicación', fecha_inicio: dia(5), ubicacion: 'Sala X' });
  store.seed('cero-cero', { ...base, nombre: 'Par cero', fecha_inicio: dia(6), lat: 0, lng: 0, source: 'fever' });
  store.seed('discrepante', { ...base, nombre: 'Fuentes contradictorias', fecha_inicio: dia(7), geo: { latitude: 37.38, longitude: -5.99 }, geo_precision: 'lugar', lat: 37.5, lng: -5.8 });
  store.seed('ambigua', { nombre: 'Categoría ambigua', categoria: 'ocio', fecha_inicio: dia(8), lat: 36.7, lng: -4.4 });
  store.seed('recurrente', { ...base, nombre: 'Todos los jueves', fecha: 'cada jueves', lat: 36.7, lng: -4.4 });
  store.seed('lejano', { ...base, nombre: 'Dentro de siete meses', fecha_inicio: dia(200) });
  store.seed('ok', { ...base, nombre: 'Todo bien', fecha_inicio: dia(9), lat: 36.7, lng: -4.4 });
  store.seed('retirado', { ...base, nombre: 'Retirado', fecha_inicio: dia(5), retirado: true, activa: false, estado: 'retirado' });
  store.seed('pasado', { ...base, nombre: 'Pasado', fecha_inicio: dia(-30) });
  store.seed('prueba', { ...base, nombre: 'De prueba', fecha_inicio: dia(5), prueba: true });
  return new CatalogoService(store, { pausaMs: 0 });
}

test('pendientes: lista lo que bloquea o degrada un evento visible, con motivo y cómo resolverlo', async () => {
  const r = await conPendientes().pending({}, owner);
  const por = Object.fromEntries(r.items.map((i) => [i.eventId + ':' + i.pendiente.tipo, i.pendiente.motivo]));
  assert.equal(por['sin-ubicacion:ubicacion'], 'sin_coordenadas');
  assert.equal(por['cero-cero:ubicacion'], 'solo_coordenadas_invalidas');
  assert.equal(por['discrepante:ubicacion'], 'fuentes_no_coinciden');
  assert.equal(por['ambigua:categoria'], 'valor_original_ambiguo');
  assert.equal(por['recurrente:fecha'], 'recurrencia_sin_calendario');
  assert.equal(por['lejano:ubicacion'], 'sin_coordenadas');
  const ids = new Set(r.items.map((i) => i.eventId));
  for (const fuera of ['ok', 'retirado', 'pasado', 'prueba']) assert.ok(!ids.has(fuera), fuera + ' no es un pendiente');
  assert.ok(r.items.every((i) => i.comoResolver && i.pendiente.motivo));
  assert.deepEqual(r.porTipo, { ubicacion: 4, categoria: 1, fecha: 1 });
  assert.equal(r.total, r.items.length);
});

test('pendientes: filtros por tipo y ventana, y paginación estable', async () => {
  const svc = conPendientes();
  const ubicacion = await svc.pending({ tipo: 'ubicacion' }, owner);
  assert.ok(ubicacion.items.every((i) => i.pendiente.tipo === 'ubicacion'));
  const enVentana = await svc.pending({ tipo: 'ubicacion', soloEnVentana: true }, owner);
  assert.ok(enVentana.total < ubicacion.total, 'el evento de dentro de siete meses queda fuera de la ventana');
  assert.ok(!enVentana.items.some((i) => i.eventId === 'lejano'));
  const todos = await svc.pending({ limite: 2 }, owner);
  assert.equal(todos.devueltos, 2);
  const siguiente = await svc.pending({ limite: 2, desde: todos.siguienteDesde }, owner);
  assert.ok(!todos.items.some((a) => siguiente.items.some((b) => b.eventId === a.eventId && b.pendiente.tipo === a.pendiente.tipo)));
  assert.equal((await svc.pending({ tipo: 'fecha' }, owner)).total, 1);
  await assert.rejects(svc.pending({ tipo: 'otra' }, owner), /invalid_type/);
});

test('pendientes: resolver un caso con revisar_catalogo lo saca de la lista', async () => {
  const svc = conPendientes();
  const antes = await svc.pending({ tipo: 'ubicacion' }, owner);
  await svc.review({ eventId: 'sin-ubicacion', ubicacion: { lat: 36.7213, lng: -4.4214, tipo: 'recinto', fuente: 'visita del equipo' }, motivo: 'Confirmado con la sala' }, owner);
  const despues = await svc.pending({ tipo: 'ubicacion' }, owner);
  assert.equal(despues.total, antes.total - 1);
  assert.ok(!despues.items.some((i) => i.eventId === 'sin-ubicacion'));
});

// ─────────────────────────── «verificada» solo por revisión manual ───────────────────────────

test('clasificar: ninguna ubicación queda «verificada» salvo por revisión manual; la coincidencia de campos es «coherente»', async () => {
  const store = new MemoryStore();
  const manana = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  store.seed('dos-campos', { nombre: 'Dos campos coinciden', categoria: 'musica', fecha_inicio: manana, geo: { latitude: 36.72, longitude: -4.42 }, geo_precision: 'lugar', geo_fuente: 'osm', lat: 36.7201, lng: -4.4202, source: 'fever' });
  store.seed('manual', { nombre: 'Revisado', categoria: 'musica', fecha_inicio: manana, lat: 36.5, lng: -4.5 });
  const svc = new CatalogoService(store, { pausaMs: 0 });
  await svc.review({ eventId: 'manual', ubicacion: { lat: 36.5, lng: -4.5, tipo: 'direccion_aproximada', fuente: 'visita' }, motivo: 'Confirmado' }, owner);
  const sim = await svc.classify({}, owner);
  await svc.classify({ modo: 'aplicar', runId: 'tanda-ver', codigoConfirmacion: sim.lote.codigoConfirmacion }, owner);
  assert.equal(store.rows.get('eventos/dos-campos').data.catalogo_amalia_v1.ubicacion.verificacion, 'coherente');
  assert.equal(store.rows.get('eventos/manual').data.catalogo_amalia_v1.ubicacion.verificacion, 'verificada');
  const todas = [...store.rows].filter(([k]) => k.startsWith('eventos/')).map(([, r]) => r.data.catalogo_amalia_v1?.ubicacion).filter(Boolean);
  assert.deepEqual(todas.filter((u) => u.verificacion === 'verificada').map((u) => u.fuentes[0]), ['revision_manual']);
});

// ─────────────────────────── GeoPoint con ceros (la API REST omite las coordenadas que valen 0) ───────────────────────────

test('GeoPoint: la lectura REST restituye las coordenadas omitidas (0) y un cero real no se descarta', () => {
  assert.deepEqual(decodeValue({ geoPointValue: {} }), { latitude: 0, longitude: 0 });
  assert.deepEqual(decodeValue({ geoPointValue: { longitude: 5 } }), { latitude: 0, longitude: 5 });
  assert.deepEqual(decodeValue({ geoPointValue: { latitude: 39.9 } }), { latitude: 39.9, longitude: 0 });
  assert.deepEqual(decodeValue({ geoPointValue: { latitude: 36.7, longitude: -4.4 } }), { latitude: 36.7, longitude: -4.4 });
  const hoy = new Date().toISOString().slice(0, 10), ahora = new Date().toISOString();
  const futuro = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  // Greenwich: longitud exactamente 0, latitud 39,9 (Castellón). Es una ubicación real, no un par inválido.
  const real = calcularCatalogo({ nombre: 'Castellón', fecha_inicio: futuro, ubicacion: decodeValue({ geoPointValue: { latitude: 39.9 } }), place: 'Plaza Mayor' }, { hoy, ahora });
  assert.deepEqual([real.ubicacion.tipo, real.ubicacion.lat, real.ubicacion.lng], ['recinto', 39.9, 0]);
  // (0, 0) sigue siendo inválido, y queda anotado como tal (no como «sin coordenadas»)
  const nulo = calcularCatalogo({ nombre: 'Online', fecha_inicio: futuro, ubicacion: decodeValue({ geoPointValue: {} }) }, { hoy, ahora });
  assert.deepEqual([nulo.ubicacion.tipo, nulo.ubicacion.motivo], ['pendiente', 'solo_coordenadas_invalidas']);
});

test('clasificar: un evento con identificador largo se clasifica y su registro de cambios tiene clave válida y determinista', async () => {
  const store = new MemoryStore();
  const largo = 'taller-de-ceramica-en-familia-mama-pottery-domingo-1-de-marzo-11-30-13-30-y-sabado-7-de-marzo-17-30-19-30-madrid--11130133';
  assert.ok(largo.length > 100 && largo.length <= 128);
  const manana = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  store.seed(largo, { nombre: 'Taller de cerámica en familia', categoria: 'familia', fecha_inicio: manana, lat: 36.7, lng: -4.4 });
  const svc = new CatalogoService(store, { pausaMs: 0 });
  const sim = await svc.classify({}, owner);
  const r = await svc.classify({ modo: 'aplicar', runId: 'catalogo-20261104-1', codigoConfirmacion: sim.lote.codigoConfirmacion }, owner);
  assert.deepEqual([r.aplicados, r.errores.length], [1, 0]);
  assert.ok(store.rows.get('eventos/' + largo).data.catalogo_amalia_v1);
  const claves = [...store.rows.keys()].filter((k) => k.startsWith('eventos_catalogo_cambios/')).map((k) => k.split('/')[1]);
  assert.equal(claves.length, 1);
  assert.ok(claves[0].length <= 128);
  assert.equal(store.rows.get('eventos_catalogo_cambios/' + claves[0]).data.eventId, largo); // el id completo queda dentro
  const revision = await svc.review({ eventId: largo, categoria: 'business', motivo: 'Prueba de clave larga' }, owner);
  assert.equal(revision.catalogo.categoria.id, 'business');
});
