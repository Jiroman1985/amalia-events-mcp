import test from 'node:test';
import assert from 'node:assert/strict';
import { escanearDuplicados, reglaDuplicado, claveNombre } from '../dedup_amalia.mjs';
import { originKey } from '../event-domain.mjs';
import { EventService } from '../event-service.mjs';

const owner = { id: 'owner', actions: ['*'], businesses: ['*'] };
const prev = (o = {}) => ({ id: 'ev_moi', data: { titulo: 'Moi Animal', city: 'Ourense', lugar: 'Teatro Principal', fechaLocal: '2026-12-05', horaLocal: '18:30', fuentes: [{ url: 'https://teatro.example/moi' }], ...o } });
const cand = (o = {}) => ({ negocioId: 'b1', titulo: 'Moi Animal', city: 'Ourense', lugar: 'Teatro Principal', fechaLocal: '2026-12-05', horaLocal: '18:30', fuentes: [{ url: 'https://teatro.example/moi' }], ...o });
const ids = r => r.coincidencias.map(c => c.eventId);

test('claveNombre: minúsculas, sin tildes ni signos, espacios recortados', () => {
  assert.equal(claveNombre('  ¡MOI,   Ánimal! '), 'moi animal');
  assert.equal(claveNombre('Concerto de Santa Cecília.'), 'concerto de santa cecilia');
});

test('misma sesión exacta: duplicado (se rechaza)', () => {
  const r = escanearDuplicados(cand(), [prev()]);
  assert.deepEqual(ids(r), ['ev_moi']); assert.ok(r.coincidencias[0].motivos.includes('duplicado_sesion'));
});

test('mismo evento, mismo día y sitio, OTRA hora: otra sesión, se admite (caso Moi Animal 21:00 vs 18:30)', () => {
  const r = escanearDuplicados(cand({ horaLocal: '21:00' }), [prev()]);
  assert.deepEqual(r.coincidencias, []);
});

test('con hora y sin hora (en cualquiera de los dos lados): duplicado', () => {
  assert.deepEqual(ids(escanearDuplicados(cand({ horaLocal: null }), [prev()])), ['ev_moi']);
  assert.deepEqual(ids(escanearDuplicados(cand({ horaLocal: '21:00' }), [prev({ horaLocal: null })])), ['ev_moi']);
  assert.deepEqual(ids(escanearDuplicados(cand({ horaLocal: null }), [prev({ horaLocal: null })])), ['ev_moi']);
});

test('nombre con tildes, mayúsculas o signos distintos: duplicado', () => {
  for (const t of ['MOI ANIMAL', 'Moí Ánimal', '¡Moi, Animal!', '  moi   animal  ']) assert.deepEqual(ids(escanearDuplicados(cand({ titulo: t }), [prev()])), ['ev_moi'], t);
});

test('otra fecha, otro municipio u otro recinto: otro evento, se admite', () => {
  assert.deepEqual(escanearDuplicados(cand({ fechaLocal: '2026-12-06' }), [prev()]).coincidencias, []);
  assert.deepEqual(escanearDuplicados(cand({ city: 'Vigo' }), [prev()]).coincidencias, []);
  assert.deepEqual(escanearDuplicados(cand({ lugar: 'Auditorio Municipal' }), [prev()]).coincidencias, []);
});

test('recinto ausente o igual al municipio no distingue lugares', () => {
  assert.deepEqual(ids(escanearDuplicados(cand({ lugar: null }), [prev()])), ['ev_moi']);
  assert.deepEqual(ids(escanearDuplicados(cand({ lugar: 'Ourense' }), [prev()])), ['ev_moi']);
  assert.equal(reglaDuplicado(cand({ lugar: 'teatro  principal' }), prev()), 'duplicado');
});

test('nombre en otro idioma muy parecido: se admite con aviso «posible duplicado» e ID del parecido', () => {
  const p = prev({ titulo: 'Concierto de Santa Cecilia' });
  const r = escanearDuplicados(cand({ titulo: 'Concerto de Santa Cecilia' }), [p]);
  assert.deepEqual(r.coincidencias, []);
  assert.equal(r.informativas.length, 1);
  assert.equal(r.informativas[0].eventId, 'ev_moi'); assert.equal(r.informativas[0].confianza, 'posible_duplicado');
  assert.ok(r.informativas[0].motivos.includes('posible_duplicado'));
  // si cambia la hora no hay ni aviso de posible duplicado
  assert.equal(escanearDuplicados(cand({ titulo: 'Concerto de Santa Cecilia', horaLocal: '21:00' }), [p]).informativas.some(i => i.confianza === 'posible_duplicado'), false);
});

test('nombres distintos no avisan', () => {
  const r = escanearDuplicados(cand({ titulo: 'Obradoiro de olería' }), [prev()]);
  assert.deepEqual(r.coincidencias, []); assert.equal(r.informativas.some(i => i.confianza === 'posible_duplicado'), false);
});

test('misma URL, sesionId o título contenido ya no bloquean por sí solos', () => {
  assert.deepEqual(escanearDuplicados(cand({ titulo: 'Otra obra', fechaLocal: '2026-12-09', sesionId: 'x' }), [prev()]).coincidencias, []);
  assert.deepEqual(escanearDuplicados(cand({ titulo: 'Moi Animal: gira 2026', lugar: 'Otro sitio' }), [prev()]).coincidencias, []);
});

test('la reserva de origen exacta sigue bloqueando (idempotencia del proveedor)', () => {
  const origen = { proveedor: 'p', id_externo: '1', id_sesion: '1' };
  const r = escanearDuplicados(cand({ titulo: 'Nada que ver', fechaLocal: '2027-01-01', origen }), [prev()], { reservas: [{ id: originKey(origen), eventId: 'ev_moi' }] });
  assert.deepEqual(ids(r), ['ev_moi']);
});

// --- buscar_duplicados_global: alcance, traza y exhaustividad ---
class Store {
  constructor(rows, { guardChanges = false } = {}) { this.rows = rows; this.guardChanges = guardChanges; this.reads = 0; }
  async get(c, id) { if (c === 'amalia_catalog_guard') return { id, data: { epoch: 1 }, updateTime: this.guardChanges ? 'g' + (this.reads++) : 'g1' }; return null; }
  async list(c, { cursor, limit = 50 } = {}) { if (c !== 'eventos') return []; const all = this.rows.filter(r => !cursor || r.id > cursor); return all.slice(0, limit); }
}
const mk = n => Array.from({ length: n }, (_, i) => ({ id: 'ev_' + String(i).padStart(5, '0'), data: { titulo: 'Evento ' + i, city: 'X' + i, fechaLocal: '2026-12-01', retirado: i % 10 === 0 ? true : undefined } }));
const find = (store, input = {}) => new EventService(store, {}, { warm: false }).findDuplicates({ titulo: 'Moi Animal', city: 'Ourense', fechaLocal: '2026-12-05', ...input }, owner);

test('global: incluye alcance aplicado, traza y recuento por estado; exhaustivo cuando se llega al final', async () => {
  const r = await find(new Store(mk(1200)));
  assert.equal(r.exhaustivo, true); assert.equal(r.escaneados, 1200); assert.ok(/^[0-9a-f-]{36}$/.test(r.traza));
  assert.equal(r.alcance.coleccion, 'eventos'); assert.deepEqual(r.alcance.filtros, { negocio: null, estado: null, zona: null, municipio: null, fechas: null });
  assert.ok(r.alcance.incluye.includes('retirados')); assert.equal(r.alcance.documentosEnColeccion, 1200);
  assert.equal(r.alcance.composicion.retirados, 120); assert.equal(r.alcance.composicion.vigentes, 1080);
  assert.equal(r.barrido.catalogoEstable, true); assert.notEqual(r.traza, (await find(new Store(mk(5)))).traza);
});

test('global: un resultado parcial por límite NO se marca exhaustivo y dice por qué', async () => {
  const r = await find(new Store(mk(1200)), { limite: 1000 });
  assert.equal(r.exhaustivo, false); assert.equal(r.motivoParcial, 'limite_alcanzado'); assert.equal(r.escaneados, 1000);
});

test('global: si el catálogo cambia durante la lectura se repite y, si sigue cambiando, no es exhaustivo', async () => {
  const r = await find(new Store(mk(30), { guardChanges: true }));
  assert.equal(r.exhaustivo, false); assert.equal(r.motivoParcial, 'catalogo_modificado_durante_lectura'); assert.equal(r.barrido.intentos, 3); assert.equal(r.barrido.catalogoEstable, false);
});

test('global: aplica la misma regla (otra hora se admite, misma hora bloquea, parecido avisa)', async () => {
  const rows = [{ id: 'ev_moi', data: { titulo: 'Moi Animal', city: 'Ourense', lugar: 'Teatro Principal', fechaLocal: '2026-12-05', horaLocal: '18:30' } },
                { id: 'ev_cec', data: { titulo: 'Concierto de Santa Cecilia', city: 'Ourense', lugar: 'Teatro Principal', fechaLocal: '2026-12-05', horaLocal: '21:00' } }];
  const otraHora = await find(new Store(rows), { lugar: 'Teatro Principal', horaLocal: '21:00' });
  assert.deepEqual(otraHora.coincidencias, []);
  const misma = await find(new Store(rows), { lugar: 'Teatro Principal', horaLocal: '18:30' });
  assert.deepEqual(misma.coincidencias.map(c => c.eventId), ['ev_moi']);
  const parecido = await find(new Store(rows), { titulo: 'Concerto de Santa Cecilia', lugar: 'Teatro Principal', horaLocal: '21:00' });
  assert.deepEqual(parecido.coincidencias, []); assert.equal(parecido.informativas[0].eventId, 'ev_cec'); assert.equal(parecido.informativas[0].confianza, 'posible_duplicado');
});

// --- Caso Noja (ev_505143f5… repetía ev_0914c430…): el mismo taller con el título reescrito ---
import { terminosNombre } from '../dedup_amalia.mjs';
const NOJA = { negocioId: 'biz_322759af0950bb07e186b35177904151', city: 'Noja', lugar: 'Sala Polivalente del Centro Cívico', fechaLocal: '2026-12-04', horaLocal: '16:30' };
const nojaPrevio = { id: 'ev_0914c430539326170287cb88b91aa862', data: { ...NOJA, titulo: 'Taller Corona de Navidad', sesionId: 'noja-corona-navidad-20261204-1630', fuentes: [{ url: 'https://ayuntamientodenoja.es/portal/evento/nojavidad-2026-2' }], dateTime: '2026-12-04T15:30:00.000Z', timeZone: 'Europe/Madrid' } };
const nojaNuevo = { ...NOJA, titulo: 'Taller de corona navideña', sesionId: 'amalia-noja-corona-navidena-20261204-1630', fuentes: [{ url: 'https://ayuntamientodenoja.es/portal/evento/taller-de-corona-navidena-crea-tu-propia-decoracion/' }, { url: 'https://ayuntamientodenoja.es/portal/evento/taller-de-suelo-pelvico/' }] };

test('Noja: mismo taller con el título reescrito (orden, flexión y artículos) el mismo día, lugar y hora es duplicado', () => {
  assert.deepEqual([...terminosNombre('Taller de corona navideña')].sort(), [...terminosNombre('Taller Corona de Navidad')].sort());
  const r = escanearDuplicados(nojaNuevo, [nojaPrevio]);
  assert.deepEqual(r.coincidencias.map(c => c.eventId), ['ev_0914c430539326170287cb88b91aa862']); assert.ok(r.coincidencias[0].motivos.includes('duplicado_sesion'));
});

test('Noja: no bloquea sesiones distintas legítimas (otra hora, otro día, otro recinto, otra actividad o variante con palabras de más)', () => {
  assert.deepEqual(escanearDuplicados({ ...nojaNuevo, horaLocal: '18:30' }, [nojaPrevio]).coincidencias, []);
  assert.deepEqual(escanearDuplicados({ ...nojaNuevo, fechaLocal: '2026-12-05' }, [nojaPrevio]).coincidencias, []);
  assert.deepEqual(escanearDuplicados({ ...nojaNuevo, lugar: 'Biblioteca Municipal' }, [nojaPrevio]).coincidencias, []);
  assert.deepEqual(escanearDuplicados({ ...nojaNuevo, titulo: 'Taller de suelo pélvico' }, [nojaPrevio]).coincidencias, []);
  assert.deepEqual(escanearDuplicados({ ...nojaNuevo, titulo: 'Taller de iniciación a la guitarra' }, [nojaPrevio]).coincidencias, []);
  // variante con una palabra más (p. ej. infantil): no es el mismo nombre; avisa de posible duplicado pero admite
  const v = escanearDuplicados({ ...nojaNuevo, titulo: 'Taller infantil de corona navideña' }, [nojaPrevio]);
  assert.deepEqual(v.coincidencias, []); assert.equal(v.informativas.find(i => i.eventId === 'ev_0914c430539326170287cb88b91aa862')?.confianza, 'posible_duplicado');
  // título de una sola palabra o sin términos suficientes: no se usa la comparación por términos
  assert.deepEqual(escanearDuplicados({ ...nojaNuevo, titulo: 'Corona' }, [nojaPrevio]).coincidencias, []);
});

test('Noja: la hora definida se compara como hora local (zona Europe/Madrid): 16:30 local = 15:30Z no es una hora distinta', () => {
  assert.deepEqual(escanearDuplicados({ ...nojaNuevo, horaLocal: '16:30' }, [{ ...nojaPrevio, data: { ...nojaPrevio.data, horaLocal: undefined, hora: undefined, dateTime: '2026-12-04T16:30:00+01:00' } }]).coincidencias.map(c => c.eventId), ['ev_0914c430539326170287cb88b91aa862']);
  assert.deepEqual(escanearDuplicados({ ...nojaNuevo, horaLocal: '15:30' }, [nojaPrevio]).coincidencias, []);
});
