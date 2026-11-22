import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSource, sourceId, registrarFuente, buscarFuente, matchRegistry } from '../registro-fuentes.mjs';
import { createApp } from '../server-v2.mjs';
import { hash, DomainError } from '../event-domain.mjs';

const writer = { id: 'hark', actions: ['admit', 'read', 'register_source'], businesses: ['*'] };
const reader = { id: 'solo-lectura', actions: ['read'], businesses: ['*'] };
const noRead = { id: 'nadie', actions: ['admit'], businesses: ['*'] };

function fakeStore(seed = []) {
  const docs = new Map(seed.map(r => [r.id, { id: r.id, data: r.data, updateTime: '2026-11-08T00:00:00Z' }]));
  const calls = { writes: [], lists: 0 };
  return {
    docs, calls,
    async get(c, k) { return docs.get(k) || null; },
    async list(c, { cursor, limit = 50 } = {}) {
      calls.lists++; assert.equal(c, 'registro_fuentes');
      const all = [...docs.values()].sort((a, b) => a.id < b.id ? -1 : 1);
      const start = cursor ? all.findIndex(r => r.id === cursor) + 1 : 0;
      return all.slice(start, start + limit);
    },
    async write(c, k, data, opts) {
      assert.equal(c, 'registro_fuentes'); assert.equal(opts.create, true);
      calls.writes.push({ k, data });
      if (docs.has(k)) throw new DomainError('version_conflict');
      docs.set(k, { id: k, data, updateTime: '2026-11-10T00:00:00Z' }); return { id: k, data };
    }
  };
}
const existing = (canal, identificador, extra = {}) => ({ id: sourceId(canal, identificador), data: { id: sourceId(canal, identificador), canal, identificador, url: canal === 'web' ? 'https://' + identificador : `https://www.instagram.com/${identificador}/`, nombre_entidad: extra.nombre ?? 'X', municipio: extra.municipio ?? 'Marbella', estado: 'descubierta', origen: 'asistente', eventos_aportados: 2, ...extra.data } });
const base = { canal: 'web', url: 'https://www.museorallye.es/agenda/', nombreEntidad: 'Museo Rallye Marbella', municipio: 'Marbella', via: 'Agenda oficial enlazada desde el perfil municipal' };
const code = async p => { try { await p; return null; } catch (e) { return e.code; } };

test('identidad canónica: variantes de la misma web dan el mismo id y respetan las reglas del registro', () => {
  const ids = ['http://museorallye.es/agenda', 'https://WWW.MuseoRallye.es/agenda/', 'https://museorallye.es/agenda?utm=1#x', 'https://www.museorallye.es/agenda///'].map(u => canonicalSource({ canal: 'web', url: u }));
  for (const c of ids) { assert.equal(c.identificador, 'museorallye.es/agenda'); assert.equal(c.url, 'https://museorallye.es/agenda'); }
  assert.equal(sourceId('web', 'museorallye.es/agenda'), 'fte_web_' + hash('museorallye.es/agenda').slice(0, 24));
  const a = canonicalSource({ canal: 'instagram', url: 'https://www.instagram.com/AuditorioManueldeFalla/?hl=es' }), b = canonicalSource({ canal: 'instagram', usuario: '@auditoriomanueldefalla' });
  assert.deepEqual(a, b); assert.equal(a.url, 'https://www.instagram.com/auditoriomanueldefalla/');
  assert.equal(sourceId('instagram', 'auditoriomanueldefalla'), 'fte_instagram_6ccea2fb9959e474a22c11f5'); // id real ya presente en el registro
  assert.equal(canonicalSource({ canal: 'tiktok', usuario: '@Foo.Bar' }).url, 'https://www.tiktok.com/@foo.bar');
});

test('identidades inválidas se rechazan', () => {
  for (const bad of [{ canal: 'web', url: 'http://localhost/x' }, { canal: 'web', url: 'https://10.0.0.1/x' }, { canal: 'web', url: 'https://user:pw@x.es/' }, { canal: 'web', url: 'ftp://x.es' }, { canal: 'web', url: 'https://sinpunto/' }, { canal: 'web', url: 'https://instagram.com/foo' }, { canal: 'instagram', url: 'https://www.instagram.com/p/ABC/' }, { canal: 'instagram', usuario: 'con espacios' }, { canal: 'tiktok', url: 'https://www.instagram.com/foo/' }, { canal: 'x', url: 'https://x.es' }])
    assert.throws(() => canonicalSource(bad), e => e instanceof DomainError, JSON.stringify(bad));
});

test('registrar una fuente nueva escribe UN documento con la forma del panel y estado descubierta', async () => {
  const store = fakeStore(), r = await registrarFuente(store, { ...base, provincia: 'Málaga', categoria: 'entretenimiento_y_cultura' }, writer, { now: () => '2026-11-10T10:00:00.000Z' });
  assert.equal(r.registrada, true); assert.equal(store.calls.writes.length, 1);
  const d = store.calls.writes[0].data;
  for (const k of ['canal', 'categoria', 'claim', 'consentimiento', 'contacto', 'creada_en', 'eventos_aportados', 'fallos_seguidos', 'fuera_de_territorio', 'id', 'identificador', 'incidencia', 'municipio', 'negocio_id', 'nombre_entidad', 'origen', 'plan_solicitado', 'periodo_solicitado', 'provincia', 'proxima_revision', 'reclamaciones', 'ultima_revision', 'ultimo_resultado', 'url', 'via', 'estado']) assert.ok(k in d, k);
  for (const k of ['codigo', 'tipo', 'comarca', 'zona', 'url_normalizada', 'redes', 'email', 'telefono', 'frecuencia_dias', 'responsable', 'motivo_bloqueo', 'ultimo_evento_encontrado', 'notas', 'creada_por', 'modificada_por', 'modificada_en']) assert.ok(k in d, k);
  assert.equal(d.responsable, 'hark'); assert.equal(d.creada_por, 'hark'); assert.equal(d.frecuencia_dias, 7); assert.equal(d.url_normalizada, 'museorallye.es/agenda');
  assert.equal(d.estado, 'descubierta'); assert.equal(d.origen, 'asistente'); assert.equal(d.negocio_id, null); assert.equal(d.eventos_aportados, 0); assert.equal(d.identificador, 'museorallye.es/agenda');
  assert.match(d.via, /^\[hark\]/); assert.equal(d.id, r.fuenteId);
});

test('si la fuente ya existe NO escribe (misma URL con otra forma, id distinto heredado y soloComprobar incluidos)', async () => {
  for (const seed of [existing('web', 'museorallye.es/agenda'), { id: 'fte_web_legacy000000000000000001', data: { ...existing('web', 'museorallye.es/agenda').data, id: 'fte_web_legacy000000000000000001' } }, { id: 'fte_web_otroid0000000000000000002', data: { id: 'fte_web_otroid0000000000000000002', canal: 'web', identificador: 'otro', url: 'http://www.MuseoRallye.es/agenda/', nombre_entidad: 'Z', municipio: 'Marbella', estado: 'bloqueada' } }]) {
    for (const extra of [{}, { soloComprobar: true }, { confirmarDistinta: true, motivo: 'intento de forzar el alta' }]) {
      const store = fakeStore([seed]), r = await registrarFuente(store, { ...base, ...extra }, writer);
      assert.equal(r.registrada, false); assert.equal(r.yaExistia, true); assert.equal(r.fuenteId, seed.id); assert.equal(store.calls.writes.length, 0);
    }
  }
});

test('fuentes parecidas (solo el nombre/dominio): se ADMITE y devuelve aviso de posible duplicado, sin borrar ni fusionar', async () => {
  const seed = existing('web', 'museorallye.es', { nombre: 'Museo Rallye Marbella' }); // mismo dominio, ruta distinta + misma entidad
  const store = fakeStore([seed]);
  const r = await registrarFuente(store, base, writer);
  assert.equal(r.registrada, true); assert.equal(store.calls.writes.length, 1);
  assert.equal(r.avisos[0].tipo, 'posible_duplicado'); assert.equal(r.avisos[0].fuenteId, seed.id); assert.ok(r.avisos[0].motivos.includes('misma_entidad'));
});

test('misma entidad en otro canal (web ya registrada, ahora Instagram): se admite con aviso, no es duplicado', async () => {
  const store = fakeStore([existing('web', 'museorallye.es', { nombre: 'Museo Rallye Marbella' })]);
  const r = await registrarFuente(store, { canal: 'instagram', usuario: 'museorallye', nombreEntidad: 'Museo Rallye Marbella', municipio: 'Marbella', via: 'Perfil enlazado desde la web oficial' }, writer);
  assert.equal(r.registrada, true); assert.equal(r.avisos[0].tipo, 'posible_duplicado'); assert.equal(store.calls.writes.length, 1);
});

test('carrera: si otro proceso crea la misma fuente entre la comprobación y la escritura, no duplica', async () => {
  const store = fakeStore(), id = sourceId('web', 'museorallye.es/agenda'), realList = store.list.bind(store);
  store.list = async (...a) => { const out = await realList(...a); store.docs.set(id, { id, data: existing('web', 'museorallye.es/agenda').data, updateTime: 'T' }); return out; };
  const r = await registrarFuente(store, base, writer);
  assert.equal(r.registrada, false); assert.equal(r.yaExistia, true); assert.equal(store.calls.writes.length, 1); assert.equal(store.docs.size, 1);
});

test('registro mayor que una página se recorre completo; si no se puede leer, falla cerrado y no escribe', async () => {
  const seed = Array.from({ length: 1203 }, (_, i) => existing('web', `fuente${String(i).padStart(4, '0')}.es`, { nombre: 'N' + i, municipio: 'M' + i }));
  seed.push(existing('web', 'zzzultima.es/agenda', { nombre: 'Ultima', municipio: 'Zz' }));
  const store = fakeStore(seed), r = await registrarFuente(store, { ...base, url: 'https://zzzultima.es/agenda', nombreEntidad: 'Ultima entidad', municipio: 'Zz' }, writer);
  assert.equal(r.yaExistia, true); assert.ok(store.calls.lists >= 3); assert.equal(store.calls.writes.length, 0);
  const broken = fakeStore(); broken.list = async () => { throw new DomainError('firestore_http_503'); };
  assert.equal(await code(registrarFuente(broken, base, writer)), 'firestore_http_503'); assert.equal(broken.calls.writes.length, 0);
  const none = fakeStore(); none.list = async () => null; assert.equal(await code(registrarFuente(none, base, writer)), 'incomplete_scan');
});

test('permisos: registrar exige register_source; buscar exige read; validaciones de campos', async () => {
  const store = fakeStore();
  assert.equal(await code(registrarFuente(store, base, reader)), 'forbidden');
  assert.equal(await code(buscarFuente(store, { url: 'https://x.es' }, noRead)), 'forbidden');
  assert.equal(await code(registrarFuente(store, { ...base, municipio: ' ' }, writer)), 'fuente_municipio_requerido');
  assert.equal(await code(registrarFuente(store, { ...base, via: 'corto' }, writer)), 'fuente_via_requerida');
  assert.equal(await code(registrarFuente(store, { ...base, categoria: 'Con Mayúsculas' }, writer)), 'fuente_categoria_invalida');
  assert.equal(store.calls.writes.length, 0);
  assert.equal((await registrarFuente(store, { ...base, soloComprobar: true }, writer)).disponible, true); assert.equal(store.calls.writes.length, 0);
});

test('buscar_fuente: exacta por URL o usuario, parecidas por nombre, y sin criterios falla', async () => {
  const store = fakeStore([existing('instagram', 'auditoriomanueldefalla', { nombre: 'Auditorio Manuel de Falla', municipio: 'Granada' }), existing('web', 'olvera.es/es', { nombre: 'Ayuntamiento de Olvera', municipio: 'Olvera' })]);
  const a = await buscarFuente(store, { url: 'https://www.instagram.com/AuditorioManueldeFalla/' }, reader); assert.equal(a.yaRegistrada, true);
  const b = await buscarFuente(store, { canal: 'web', url: 'http://www.olvera.es/es/' }, reader); assert.equal(b.yaRegistrada, true); assert.equal(b.escaneadas, 2);
  const c = await buscarFuente(store, { nombre: 'Ayuntamiento de Olvera' }, reader); assert.equal(c.yaRegistrada, false); assert.equal(c.parecidas.length, 1);
  assert.equal(await code(buscarFuente(store, {}, reader)), 'fuente_busqueda_vacia');
  assert.equal(matchRegistry(null, [], { nombre: 'x' }).exactas.length, 0);
});

test('MCP: las dos herramientas aparecen, respetan permisos y el catálogo previo no cambia', async () => {
  const token = 'local-fixture-only-registro-fuentes', principal = { id: 'fixture', tokenHash: hash(token), actions: ['read', 'register_source'], businesses: ['*'] }, store = fakeStore();
  const app = createApp({ store, events: {}, editorial: { pausedNow: () => true }, media: { serve: () => null } }, [principal]);
  await new Promise(r => app.listen(0, '127.0.0.1', r)); const base_ = 'http://127.0.0.1:' + app.address().port;
  const call = async (method, params) => (await fetch(base_ + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  try {
    const names = (await call('tools/list', {})).result.tools.map(t => t.name);
    assert.ok(names.includes('buscar_fuente') && names.includes('registrar_fuente') && names.includes('preparar_admision') && names.includes('admitir_candidato'));
    const r1 = (await call('tools/call', { name: 'registrar_fuente', arguments: { canal: 'instagram', usuario: 'museorallye', nombreEntidad: 'Museo Rallye Marbella', municipio: 'Marbella', via: 'Perfil enlazado desde la web oficial' } })).result.structuredContent.result;
    assert.equal(r1.registrada, true);
    const r2 = (await call('tools/call', { name: 'registrar_fuente', arguments: { canal: 'instagram', url: 'https://www.instagram.com/MuseoRallye/', nombreEntidad: 'Museo Rallye Marbella', municipio: 'Marbella', via: 'Perfil enlazado desde la web oficial' } })).result.structuredContent.result;
    assert.equal(r2.yaExistia, true); assert.equal(store.docs.size, 1);
    const s = (await call('tools/call', { name: 'buscar_fuente', arguments: { usuario: 'museorallye', canal: 'instagram' } })).result.structuredContent.result; assert.equal(s.yaRegistrada, true);
  } finally { app.closeAllConnections(); await new Promise(r => app.close(r)); }
});

test('Bandomovil: la identidad conserva el parámetro municipio; el resto de la query se descarta', () => {
  const a = canonicalSource({ canal: 'web', url: 'https://www.bandomovil.com/web_widget.php?municipio=lalastrilla&sec=Bando&id=1673166' });
  const b = canonicalSource({ canal: 'web', url: 'https://www.bandomovil.com/web_widget.php?municipio=monesterio&sec=Bando&id=1' });
  const c = canonicalSource({ canal: 'web', url: 'https://bandomovil.com/web_widget.php?id=9&municipio=LaLastrilla' });
  assert.equal(a.identificador, 'bandomovil.com/web_widget.php?municipio=lalastrilla');
  assert.notEqual(sourceId('web', a.identificador), sourceId('web', b.identificador));
  assert.equal(a.identificador, c.identificador);
  assert.equal(canonicalSource({ canal: 'web', url: 'https://museorallye.es/agenda?municipio=x' }).identificador, 'museorallye.es/agenda');
});

// ---- 2.15: via multilínea, ámbito, actualizar_fuente ----
import { actualizarFuente } from '../registro-fuentes.mjs';
class Store {
  constructor() { this.rows = new Map(); this.seq = 0; }
  async get(c, k) { const r = this.rows.get(k); return r ? { id: k, data: structuredClone(r.data), updateTime: r.updateTime } : null; }
  async list() { return [...this.rows].map(([id, r]) => ({ id, data: structuredClone(r.data), updateTime: r.updateTime })).sort((a, b) => (a.id < b.id ? -1 : 1)); }
  async write(c, k, data, { updateTime, create } = {}) {
    const cur = this.rows.get(k);
    if ((create && cur) || (!create && cur?.updateTime !== updateTime)) throw new DomainError('version_conflict');
    this.rows.set(k, { data: structuredClone(data), updateTime: 't' + (++this.seq) }); return { id: k, data };
  }
}
test('via con saltos de línea se acepta; via corta explica la longitud', async () => {
  const store = new Store(), writer = { id: 'ag', actions: ['register_source'], businesses: ['*'] };
  const base = { canal: 'instagram', usuario: 'impacthubmlg', nombreEntidad: 'Impact Hub Málaga', municipio: 'Málaga' };
  const ok = await registrarFuente(store, { ...base, via: 'Perfil oficial de la entidad.\nAnuncia talleres cada semana.' }, writer);
  assert.equal(ok.registrada, true);
  await assert.rejects(registrarFuente(store, { ...base, usuario: 'otro', via: ' corto \n ' }, writer), e => e.code === 'fuente_via_requerida' && /10 caracteres/.test(e.details.ayuda));
});
test('fuente sin municipio: ámbito región con zona; sin zona se rechaza', async () => {
  const store = new Store(), writer = { id: 'ag', actions: ['register_source'], businesses: ['*'] };
  const base = { canal: 'web', url: 'https://turismo-galicia.example/agenda', nombreEntidad: 'Agenda Galicia', via: 'Agenda regional con eventos de toda Galicia.' };
  await assert.rejects(registrarFuente(store, { ...base, ambito: 'region' }, writer), e => e.code === 'fuente_ambito_sin_zona');
  const r = await registrarFuente(store, { ...base, ambito: 'region', region: 'Galicia' }, writer);
  assert.equal(r.registrada, true);
  const doc = [...store.rows.values()][0].data;
  assert.equal(doc.municipio, null); assert.equal(doc.ambito, 'region'); assert.equal(doc.region, 'Galicia');
});
test('actualizar_fuente: corrige municipio, añade canal secundario y deja historial', async () => {
  const store = new Store(), writer = { id: 'ag', actions: ['register_source'], businesses: ['*'] };
  const r = await registrarFuente(store, { canal: 'instagram', usuario: 'cantodevimianzo', nombreEntidad: 'C@nto', municipio: 'Vimianzo', via: 'Perfil de la asociación cultural.' }, writer);
  const u = await actualizarFuente(store, { fuenteId: r.fuenteId, municipio: 'Zas', provincia: 'A Coruña', canalSecundario: { canal: 'web', url: 'https://canto.example/agenda' }, motivo: 'Corrección: la asociación está en Zas' }, writer);
  assert.equal(u.actualizada, true);
  const d = (await store.get('registro_fuentes', r.fuenteId)).data;
  assert.equal(d.municipio, 'Zas'); assert.equal(d.provincia, 'A Coruña');
  assert.equal(d.canales_secundarios[0].identificador, 'canto.example/agenda');
  assert.equal(d.historial.length, 1); assert.equal(d.historial[0].por, 'ag');
  const again = await actualizarFuente(store, { fuenteId: r.fuenteId, municipio: 'Zas', motivo: 'Sin cambios reales aquí' }, writer);
  assert.equal(again.actualizada, false);
});
test('actualizar_fuente: fusionar exige edit, une canales y marca la absorbida', async () => {
  const store = new Store(), writer = { id: 'ag', actions: ['register_source'], businesses: ['*'] }, editor = { id: 'ed', actions: ['register_source', 'edit'], businesses: ['*'] };
  const a = await registrarFuente(store, { canal: 'instagram', usuario: 'turismoa', nombreEntidad: 'Turismo A', municipio: 'Zas', via: 'Perfil de turismo de Zas.' }, writer);
  const b = await registrarFuente(store, { canal: 'web', url: 'https://turismoa.example/', nombreEntidad: 'Turismo A web', municipio: 'Zas', via: 'Web oficial de Turismo A.' }, writer, { now: () => '2026-11-19T10:00:00.000Z' });
  await assert.rejects(actualizarFuente(store, { fuenteId: a.fuenteId, fusionarDesde: b.fuenteId, motivo: 'Es la misma entidad' }, writer), /forbidden/);
  const f = await actualizarFuente(store, { fuenteId: a.fuenteId, fusionarDesde: b.fuenteId, motivo: 'Es la misma entidad' }, editor);
  assert.equal(f.fusionada, b.fuenteId);
  const da = (await store.get('registro_fuentes', a.fuenteId)).data, db = (await store.get('registro_fuentes', b.fuenteId)).data;
  assert.equal(db.estado, 'fusionada'); assert.equal(db.fusionada_en, a.fuenteId);
  assert.equal(da.canales_secundarios[0].fuenteIdAnterior, b.fuenteId);
  await assert.rejects(actualizarFuente(store, { fuenteId: b.fuenteId, municipio: 'Zas', motivo: 'Intento sobre una fusionada' }, writer), e => e.code === 'fuente_fusionada');
});
