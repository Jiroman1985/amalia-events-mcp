import test from 'node:test';
import assert from 'node:assert/strict';
import { registrarFuente, actualizarFuente, sourceId } from '../registro-fuentes.mjs';
import { marcarRevisada, listarVencidas, resumenFuentes, rendimiento, buscarFichas } from '../fuentes-consultas.mjs';
import { normalizarUrl, esEnlaceSinResolver } from '../fuentes-modelo.mjs';

const alfie = { id: 'alfie', actions: ['read', 'register_source'], businesses: ['*'] };
const conchi = { id: 'conchi', actions: ['read', 'register_source'], businesses: ['*'] };
const alfred = { id: 'alfred', actions: ['read', 'register_source', 'edit'], businesses: ['*'] };
const lector = { id: 'lector', actions: ['read'], businesses: ['*'] };
const T0 = '2026-11-21T10:00:00.000Z', ahora = Date.parse(T0);
class Store {
  constructor(seed = []) { this.docs = new Map(seed.map(r => [r.id, { id: r.id, data: r.data, updateTime: '1' }])); this.writes = []; }
  async get(c, id) { const r = this.docs.get(id); return r ? { id, data: structuredClone(r.data), updateTime: r.updateTime } : null; }
  async list(c, { cursor, limit = 500 } = {}) { return [...this.docs.values()].filter(r => !cursor || r.id > cursor).slice(0, limit).map(r => ({ id: r.id, data: structuredClone(r.data), updateTime: r.updateTime })); }
  async write(c, id, data) { this.writes.push({ c, id, data }); this.docs.set(id, { id, data: structuredClone(data), updateTime: String(this.writes.length + 1) }); return {}; }
}
const base = { canal: 'web', url: 'https://www.ayto-ejemplo.es/agenda/', nombreEntidad: 'Ayuntamiento de Ejemplo', municipio: 'Ejemplo', provincia: 'Salamanca', via: 'Web oficial del ayuntamiento, agenda cultural' };
const now = () => T0;
const doc = (id, o = {}) => ({ id, data: { id, nombre_entidad: 'Fuente ' + id, canal: 'web', url: 'https://x.es/' + id, identificador: 'x.es/' + id, municipio: 'Ejemplo', provincia: 'Salamanca', region: 'Castilla y León', estado: 'activa', responsable: 'alfie', frecuencia_dias: 7, ultima_revision: null, eventos_aportados: 0, creada_en: '2026-11-01T00:00:00.000Z', ...o } });
const code = p => p.then(() => null, e => e.code);

test('normalizarUrl: sin protocolo, www, barra final, fragmento ni tracking; conserva parámetros de identidad', () => {
  assert.equal(normalizarUrl('HTTPS://www.Ayto-Ejemplo.es/Agenda/?utm_source=x&fbclid=1#top'), 'ayto-ejemplo.es/agenda');
  assert.equal(normalizarUrl('http://ayto-ejemplo.es/agenda'), 'ayto-ejemplo.es/agenda');
  assert.equal(normalizarUrl('https://lasalina.es/agenda.html?area=Cultura&utm_medium=a'), 'lasalina.es/agenda.html?area=cultura');
  assert.equal(normalizarUrl('no es url'), null); assert.equal(esEnlaceSinResolver('https://share.google/xyz'), true);
});

test('registro: guarda el modelo completo, responsable y creador salen del token', async () => {
  const s = new Store();
  const r = await registrarFuente(s, { ...base, tipo: 'ayuntamiento', comarca: 'Campo de Salamanca', zona: 'salamanca', redes: { instagram: '@ayto_ejemplo', x: null }, email: 'Cultura@Ayto-Ejemplo.es', telefono: '+34 923 000 000', frecuenciaDias: 3, notas: 'Agenda mensual' }, alfie, { now });
  assert.equal(r.registrada, true); const d = s.writes[0].data;
  assert.equal(d.creada_por, 'alfie'); assert.equal(d.responsable, 'alfie'); assert.equal(d.modificada_por, 'alfie'); assert.equal(d.creada_en, T0);
  assert.equal(d.url_normalizada, 'ayto-ejemplo.es/agenda'); assert.equal(d.tipo, 'ayuntamiento');
  assert.deepEqual(d.redes, { instagram: '@ayto_ejemplo' }); assert.equal(d.email, 'cultura@ayto-ejemplo.es'); assert.equal(d.frecuencia_dias, 3); assert.equal(d.estado, 'descubierta');
  assert.equal(await code(registrarFuente(new Store(), { ...base, tipo: 'inventado' }, alfie)), 'fuente_tipo_invalido');
  assert.equal(await code(registrarFuente(new Store(), { ...base, email: 'no-es-email' }, alfie)), 'fuente_email_invalido');
  assert.equal(await code(registrarFuente(new Store(), base, lector)), 'forbidden');
});

test('duplicados: misma URL normalizada (www, https, barra final, tracking) se rechaza y devuelve el ID existente; no se borra nada', async () => {
  const s = new Store(); const a = await registrarFuente(s, base, alfie, { now });
  for (const url of ['http://ayto-ejemplo.es/agenda', 'https://www.ayto-ejemplo.es/agenda/?utm_campaign=x', 'HTTPS://AYTO-EJEMPLO.es/Agenda']) {
    const r = await registrarFuente(s, { ...base, url, nombreEntidad: 'Otro nombre distinto' }, conchi);
    assert.equal(r.registrada, false); assert.equal(r.rechazada, true); assert.equal(r.fuenteId, a.fuenteId);
  }
  assert.equal(s.writes.length, 1);
});

test('duplicados: misma URL normalizada guardada por otra vía (registro antiguo con otro id) también se rechaza', async () => {
  const s = new Store([{ id: 'fte_web_antiguo00000000000000001', data: { id: 'fte_web_antiguo00000000000000001', canal: 'web', identificador: 'otra-clave', url: 'https://ayto-ejemplo.es/agenda?utm_source=a' } }]);
  const r = await registrarFuente(s, base, alfie, { now });
  assert.equal(r.rechazada, true); assert.equal(r.fuenteId, 'fte_web_antiguo00000000000000001'); assert.equal(s.writes.length, 0);
});

test('duplicados: solo se parece el nombre + municipio: se admite con aviso de posible duplicado', async () => {
  const s = new Store(); const a = await registrarFuente(s, base, alfie, { now });
  const r = await registrarFuente(s, { ...base, canal: 'instagram', url: undefined, usuario: 'ayto_ejemplo' }, conchi, { now });
  assert.equal(r.registrada, true); assert.equal(r.avisos[0].tipo, 'posible_duplicado'); assert.equal(r.avisos[0].fuenteId, a.fuenteId); assert.equal(s.writes.length, 2);
});

test('enlaces share.google sin resolver se rechazan con ayuda', async () => {
  const e = await registrarFuente(new Store(), { ...base, url: 'https://share.google/AbC123' }, alfie).catch(x => x);
  assert.equal(e.code, 'fuente_url_sin_resolver');
});

test('código F-XXX-0000: solo con edit, formato válido y único', async () => {
  assert.equal(await code(registrarFuente(new Store(), { ...base, codigo: 'F-SAL-0001' }, alfie)), 'forbidden');
  assert.equal(await code(registrarFuente(new Store(), { ...base, codigo: 'SAL-1' }, alfred)), 'fuente_codigo_invalido');
  const s = new Store(); const r = await registrarFuente(s, { ...base, codigo: 'F-SAL-0001' }, alfred, { now }); assert.equal(r.codigo, 'F-SAL-0001');
  const e = await registrarFuente(s, { ...base, url: 'https://otra.es/a', nombreEntidad: 'Otra', municipio: 'Otro', codigo: 'F-SAL-0001' }, alfred, { now }).catch(x => x);
  assert.equal(e.code, 'fuente_codigo_duplicado');
  const f = await buscarFichas(s, { codigo: 'F-SAL-0001' }, alfie); assert.equal(f.fuentes[0].fuenteId, r.fuenteId);
});

test('actualizar: estado bloqueada exige motivo (con licencia), queda historial con el agente del token; por código también', async () => {
  const s = new Store(); const r = await registrarFuente(s, { ...base, codigo: 'F-SAL-0001' }, alfred, { now });
  assert.equal(await code(actualizarFuente(s, { fuenteId: r.fuenteId, estado: 'bloqueada', motivo: 'Restricción de reutilización' }, alfie)), 'fuente_motivo_bloqueo_requerido');
  const u = await actualizarFuente(s, { fuenteId: 'F-SAL-0001', estado: 'bloqueada', motivoBloqueo: { texto: 'Restricción de reutilización de contenidos', licenciaUrl: 'https://ayto-ejemplo.es/aviso-legal' }, motivo: 'Aviso legal prohíbe reutilizar' }, conchi, { now });
  assert.equal(u.actualizada, true); const d = s.docs.get(r.fuenteId).data;
  assert.equal(d.estado, 'bloqueada'); assert.equal(d.motivo_bloqueo.licenciaUrl, 'https://ayto-ejemplo.es/aviso-legal'); assert.equal(d.modificada_por, 'conchi'); assert.equal(d.historial.at(-1).por, 'conchi');
  await actualizarFuente(s, { fuenteId: r.fuenteId, estado: 'activa', frecuenciaDias: 14, responsable: 'Alfie', tipo: 'agenda', motivo: 'Se obtuvo permiso del ayuntamiento' }, alfie, { now });
  const d2 = s.docs.get(r.fuenteId).data; assert.equal(d2.motivo_bloqueo, null); assert.equal(d2.frecuencia_dias, 14); assert.equal(d2.responsable, 'alfie'); assert.equal(d2.tipo, 'agenda');
  assert.equal(await code(actualizarFuente(s, { fuenteId: r.fuenteId, estado: 'inventado', motivo: 'valor no válido aquí' }, alfie)), 'fuente_estado_invalido');
});

test('marcar_revisada: guarda fecha y eventos nuevos, recalcula la próxima revisión y usa el token', async () => {
  const s = new Store(); const r = await registrarFuente(s, { ...base, frecuenciaDias: 3 }, alfie, { now });
  const m = await marcarRevisada(s, { fuenteId: r.fuenteId, eventosNuevos: 4, fechaUltimoEvento: '2026-12-01' }, conchi, { now });
  assert.equal(m.revisada, true); assert.equal(m.revisadaPor, 'conchi'); assert.equal(m.ultimaRevision, T0); assert.equal(m.proximaRevision, '2026-11-24T10:00:00.000Z'); assert.equal(m.eventosEncontrados, 4);
  const d = s.docs.get(r.fuenteId).data; assert.equal(d.ultimo_evento_encontrado, '2026-12-01'); assert.equal(d.estado, 'activa'); assert.equal(d.fallos_seguidos, 0);
  const m2 = await marcarRevisada(s, { fuenteId: r.fuenteId, eventosNuevos: 0 }, alfie, { now: () => '2026-11-24T10:00:00.000Z' });
  assert.equal(m2.eventosEncontrados, 4); assert.equal(s.docs.get(r.fuenteId).data.ultimo_evento_encontrado, '2026-12-01');
  const e = await marcarRevisada(s, { fuenteId: r.fuenteId, eventosNuevos: 0, resultado: 'error' }, alfie, { now }); assert.equal(s.docs.get(r.fuenteId).data.fallos_seguidos, 1);
  assert.equal(await code(marcarRevisada(s, { fuenteId: r.fuenteId, eventosNuevos: -1 }, alfie)), 'fuente_eventos_nuevos_invalido');
  assert.equal(await code(marcarRevisada(s, { fuenteId: r.fuenteId, eventosNuevos: 1 }, lector)), 'forbidden');
});

test('marcar_revisada: una fuente bloqueada o descartada no se revisa', async () => {
  const s = new Store([doc('fte_web_b0000000000000000000001', { estado: 'bloqueada' })]);
  assert.equal(await code(marcarRevisada(s, { fuenteId: 'fte_web_b0000000000000000000001', eventosNuevos: 0 }, alfie)), 'fuente_no_revisable');
});

const dias = n => new Date(ahora - n * 86400000).toISOString();
const seed = () => new Store([
  doc('fte_web_a0000000000000000000001', { ultima_revision: dias(30), responsable: 'alfie', provincia: 'Cáceres', region: 'Extremadura' }),
  doc('fte_web_a0000000000000000000002', { ultima_revision: dias(10), responsable: 'alfie', provincia: 'Cáceres', region: 'Extremadura' }),
  doc('fte_web_a0000000000000000000003', { ultima_revision: dias(2), responsable: 'alfie' }),                      // al día
  doc('fte_web_a0000000000000000000004', { ultima_revision: null, responsable: 'conchi', creada_en: '2026-10-01T00:00:00Z' }), // sin revisar
  doc('fte_web_a0000000000000000000005', { ultima_revision: dias(40), responsable: 'conchi', estado: 'pausada' }),   // pausada: no vence
  doc('fte_web_a0000000000000000000006', { ultima_revision: dias(40), responsable: 'conchi', estado: 'bloqueada', motivo_bloqueo: { texto: 'licencia' } }),
  doc('fte_web_a0000000000000000000007', { ultima_revision: dias(20), responsable: 'conchi', estado: 'fusionada' }),
  doc('fte_web_a0000000000000000000008', { ultima_revision: dias(8), responsable: 'conchi', frecuencia_dias: 30 }) // vence en 22 días
]);

test('vencidas: ordenadas por antigüedad (sin revisar primero), excluyen pausadas, bloqueadas, fusionadas y al día; filtros por responsable, zona y provincia', async () => {
  const s = seed();
  const todas = await listarVencidas(s, {}, lector, { ahora });
  assert.deepEqual(todas.items.map(i => i.fuenteId.slice(-1)), ['4', '1', '2']);
  assert.equal(todas.total, 3); assert.equal(todas.items[0].sinRevisar, true); assert.ok(todas.items[1].diasVencida >= 23);
  assert.deepEqual((await listarVencidas(s, { responsable: 'alfie' }, lector, { ahora })).items.map(i => i.fuenteId.slice(-1)), ['1', '2']);
  assert.deepEqual((await listarVencidas(s, { responsable: 'yo' }, { ...lector, id: 'conchi' }, { ahora })).items.map(i => i.fuenteId.slice(-1)), ['4']);
  assert.deepEqual((await listarVencidas(s, { zona: 'extremadura' }, lector, { ahora })).items.map(i => i.fuenteId.slice(-1)), ['1', '2']);
  assert.deepEqual((await listarVencidas(s, { provincia: 'Cáceres', incluirSinRevisar: false }, lector, { ahora })).items.length, 2);
  assert.equal((await listarVencidas(s, { limite: 1, desde: 1 }, lector, { ahora })).items[0].fuenteId.slice(-1), '1');
  assert.equal(await code(listarVencidas(s, {}, { id: 'x', actions: ['admit'], businesses: ['*'] })), 'forbidden');
});

test('resumen: totales por estado, zona y responsable, vencidas, sin revisar y bloqueadas', async () => {
  const r = await resumenFuentes(seed(), {}, lector, { ahora });
  assert.equal(r.total, 7); assert.equal(r.vencidas.total, 3); assert.equal(r.sinRevisar, 1);
  assert.equal(r.porEstado.find(x => x.clave === 'activa').total, 5); assert.equal(r.porZona.find(x => x.clave === 'Extremadura').total, 2);
  assert.equal(r.porResponsable.find(x => x.clave === 'alfie').total, 3); assert.equal(r.bloqueadas.length, 1); assert.equal(r.sinZona, 0);
});

test('rendimiento: eventos por fuente (directos por fuenteId, inferidos por URL) y sin fuente identificada', () => {
  const rows = [doc('fte_web_a0000000000000000000001', { codigo: 'F-SAL-0001', url: 'https://x.es/agenda', identificador: 'x.es/agenda' }), doc('fte_web_a0000000000000000000002', { url: 'https://y.es/', identificador: 'y.es' })];
  const eventos = [
    { id: 'e1', data: { fuenteId: 'F-SAL-0001', fuentes: [{ url: 'https://z.es/' }] } },
    { id: 'e2', data: { fuenteId: 'fte_web_a0000000000000000000001' } },
    { id: 'e3', data: { fuentes: [{ url: 'https://www.x.es/agenda/detalle?id=3' }] } },
    { id: 'e4', data: { fuentes: [{ url: 'https://otra.es/' }] } },
    { id: 'e5', data: { fuenteId: 'F-ZZZ-0001' } }, { id: 'e6', data: { prueba: true, fuenteId: 'F-SAL-0001' } }
  ];
  const r = rendimiento(rows, eventos); const a = r.items.find(i => i.codigo === 'F-SAL-0001');
  assert.equal(a.eventosDirectos, 2); assert.equal(a.eventosInferidos, 1); assert.equal(a.eventos, 3);
  assert.equal(r.eventosSinFuenteIdentificada, 1); assert.equal(r.eventosConFuenteIdDesconocida, 1); assert.equal(r.items[0].codigo, 'F-SAL-0001');
});
