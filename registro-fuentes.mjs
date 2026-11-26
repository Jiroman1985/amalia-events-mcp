// registro-fuentes.mjs — alta y búsqueda de fuentes en la colección `registro_fuentes` (la que muestra el panel «Fuentes de negocios»).
// Reglas de identidad IDÉNTICAS a registro-provenance.mjs (canonicalRegistry): id = fte_<canal>_<sha256(identificador)[:24]>.
// Nunca escribe si la fuente ya existe: la comprobación recorre el registro COMPLETO (fail-closed si no puede).
import { hash, fail, authorize } from './event-domain.mjs';

export const CANALES = ['web', 'instagram', 'tiktok', 'correo'];
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/;
const RESERVED_IG = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv', 'direct', 'about', 'legal', 'developer']);
const RESERVED_TT = new Set(['discover', 'tag', 'video', 'music', 'foryou', 'live', 'upload', 'about', 'legal']);
const MAX_ROWS = 10000;

export const normalizeName = v => String(v || '').normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clean = (v, min, max, code) => { if (typeof v !== 'string') fail(code); const s = v.trim(); if (s.length < min || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) fail(code); return s; };

// «via» es texto libre: los saltos de línea y tabuladores se pasan a espacios (antes un solo salto de línea daba «fuente_via_requerida» aunque se enviara).
const cleanVia = v => {
  if (typeof v !== 'string' || !v.trim()) fail('fuente_via_requerida', { ayuda: 'Falta «via»: explica en 10-600 caracteres cómo se descubrió o por qué es una fuente válida.' });
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 10) fail('fuente_via_requerida', { longitud: s.length, ayuda: '«via» necesita al menos 10 caracteres (recibidos ' + s.length + ' tras quitar saltos de línea y espacios sobrantes).' });
  if (s.length > 600) fail('fuente_via_requerida', { longitud: s.length, ayuda: '«via» admite como máximo 600 caracteres (recibidos ' + s.length + ').' });
  return s;
};
import { agenteCanonico } from './identidad.mjs';
import { TIPOS, ESTADOS, FRECUENCIA_DEFECTO, normalizarUrl, urlClave, esEnlaceSinResolver, proximaRevision, ficha } from './fuentes-modelo.mjs';
import { deducirZona, reconocerZona, regionDeProvincia, PROVINCIAS, REGIONES } from './territorio.mjs';
export const AMBITOS = ['municipio', 'comarca', 'provincia', 'region', 'nacional'];
const AMBITO_ALIAS = { ccaa: 'region' };
const normAmbito = v => AMBITO_ALIAS[v] || v;

export function sourceId(canal, identificador) { return `fte_${canal}_${hash(identificador).slice(0, 24)}`; }

// Hosts cuya identidad real viaja en la query (p. ej. widgets de Bandomovil: ?municipio=...). Solo se conservan los parámetros listados.
export const QUERY_IDENTITY = { 'bandomovil.com': ['municipio'] };
export function queryIdentity(host, u) {
  const keys = QUERY_IDENTITY[host]; if (!keys) return '';
  const parts = keys.map(k => [k, (u.searchParams.get(k) || '').trim().toLowerCase()]).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function parseUrl(value) {
  let u; try { u = new URL(String(value).trim()); } catch { fail('fuente_url_invalida'); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) fail('fuente_url_invalida');
  return u;
}

// Devuelve {canal, identificador, url} canónicos. Acepta la URL de la fuente o, para redes, el usuario.
export function canonicalSource({ canal, url, usuario, correo }) {
  if (!CANALES.includes(canal)) fail('fuente_canal_invalido');
  if (canal === 'web') {
    const u = parseUrl(url), host = u.hostname.toLowerCase().replace(/^www\./, ''), path = u.pathname.replace(/\/+$/, '');
    if (!host.includes('.') || PRIVATE_HOST.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /(^|\.)(instagram|tiktok)\.com$/.test(host)) fail('fuente_identidad_invalida');
    const q = queryIdentity(host, u);
    return { canal, identificador: `${host}${path}${q}`.toLowerCase(), url: `https://${host}${path}${q}` };
  }
  if (canal === 'instagram' || canal === 'tiktok') {
    let handle = usuario != null ? String(usuario).trim() : null;
    if (handle == null) {
      const u = parseUrl(url), host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (host !== (canal === 'instagram' ? 'instagram.com' : 'tiktok.com')) fail('fuente_identidad_invalida');
      const first = u.pathname.split('/').filter(Boolean)[0] || '';
      handle = first;
    }
    handle = handle.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(handle) || (canal === 'instagram' ? RESERVED_IG : RESERVED_TT).has(handle)) fail('fuente_identidad_invalida');
    return { canal, identificador: handle, url: canal === 'instagram' ? `https://www.instagram.com/${handle}/` : `https://www.tiktok.com/@${handle}` };
  }
  const mail = String(correo || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) fail('fuente_identidad_invalida');
  return { canal, identificador: mail, url: '' };
}

// Lectura completa del registro (≈3.000 fuentes). Se reutiliza 15 s y se invalida con cualquier escritura propia en registro_fuentes: las herramientas de consulta
// dejan de releer toda la colección en cada llamada. Siempre se devuelve una copia (nadie comparte objetos mutables).
const REGISTRO_TTL_MS = Number(process.env.AMALIA_REGISTRO_TTL_MS || 15000);
const cacheRegistro = new WeakMap();
async function leerRegistro(store) {
  if (typeof store.listAll === 'function') { const all = await store.listAll('registro_fuentes', { max: MAX_ROWS, concurrency: 4 }); return all; }
  const rows = []; let cursor = null;
  for (;;) {
    const page = await store.list('registro_fuentes', { cursor, limit: 500 });
    if (!Array.isArray(page)) fail('incomplete_scan');
    rows.push(...page);
    if (rows.length > MAX_ROWS) fail('incomplete_scan');
    if (page.length < 500) break;
    cursor = page.at(-1).id;
  }
  return rows;
}
// Lectura con «obsoleto mientras se revalida»: una lectura completa tarda segundos (≈3.400 fichas) y compite con la carga del catálogo, así que NINGUNA consulta espera si ya hay copia.
// Fresca REGISTRO_TTL_MS; hasta REGISTRO_OBSOLETA_MS se sirve la copia y se refresca por detrás. Las escrituras propias parchean la copia (lectura de lo escrito) y, si no se puede, la marcan caducada.
const REGISTRO_OBSOLETA_MS = Number(process.env.AMALIA_REGISTRO_OBSOLETA_MS || 600000);
function refrescarRegistro(store, c) {
  if (c.carga) return c.carga;
  const gen = c.gen;
  const p = leerRegistro(store).then(rows => { if (c.carga === p) { c.carga = null; if (c.gen === gen) { c.rows = rows; c.at = Date.now(); } } return rows; }, e => { if (c.carga === p) c.carga = null; throw e; });
  c.carga = p; return p;
}
function parchearRegistro(c, key, r) {
  c.gen++;
  if (!c.rows) return;
  if (r && r.data && typeof r.data === 'object' && r.updateTime) {
    const fila = { id: String(key), data: structuredClone(r.data), updateTime: r.updateTime }, i = c.rows.findIndex(x => x.id === fila.id);
    if (i >= 0) c.rows[i] = fila; else c.rows.push(fila);
  } else { c.rows = null; }
}
export async function readRegistry(store) {
  if (REGISTRO_TTL_MS <= 0 || typeof store?.write !== 'function') return leerRegistro(store);
  let c = cacheRegistro.get(store);
  if (!c) {
    c = { at: 0, rows: null, carga: null, gen: 0 }; cacheRegistro.set(store, c);
    const write = store.write.bind(store);
    store.write = async (...a) => {
      try { const r = await write(...a); if (a[0] === 'registro_fuentes') parchearRegistro(c, a[1], r); return r; }
      catch (e) { if (a[0] === 'registro_fuentes') { c.gen++; c.at = 0; } throw e; }
    };
  }
  const edad = c.rows ? Date.now() - c.at : Infinity;
  if (edad < REGISTRO_TTL_MS) return structuredClone(c.rows);
  if (edad < REGISTRO_OBSOLETA_MS) { refrescarRegistro(store, c).catch(() => {}); return structuredClone(c.rows); }
  return structuredClone(await refrescarRegistro(store, c));
}

const summary = (row, motivos, confianza) => ({
  fuenteId: row.id, nombreEntidad: row.data.nombre_entidad ?? null, canal: row.data.canal ?? null, identificador: row.data.identificador ?? null,
  url: row.data.url ?? null, municipio: row.data.municipio ?? null, provincia: row.data.provincia ?? null, estado: row.data.estado ?? null,
  eventosAportados: row.data.eventos_aportados ?? 0, ultimaRevision: row.data.ultima_revision ?? null, codigo: row.data.codigo ?? null, responsable: row.data.responsable ?? null, zona: row.data.zona ?? row.data.region ?? row.data.provincia ?? null, motivos, confianza
});
const webKey = d => { try { const u = new URL(d.url), host = u.hostname.toLowerCase().replace(/^www\./, ''); return { host, path: u.pathname.replace(/\/+$/, '').toLowerCase(), q: queryIdentity(host, u) }; } catch { return null; } };

// Compara un candidato canónico (y, si se da, nombre+municipio) con todo el registro.
// exactas = misma identidad (mismo canal e identificador). parecidas = posible duplicado a revisar por una persona.
export function matchRegistry(canon, rows, { nombre, municipio } = {}) {
  const exactas = [], parecidas = [];
  const myId = canon ? sourceId(canon.canal, canon.identificador) : null, myName = normalizeName(nombre), myMun = normalizeName(municipio);
  const myWeb = canon?.canal === 'web' ? webKey(canon) : null;
  for (const row of rows) {
    const d = row.data || {}, motivos = [];
    if (canon) {
      if (row.id === myId) motivos.push('misma_identidad');
      else if (d.canal === canon.canal && d.identificador === canon.identificador) motivos.push('misma_identidad_id_distinto');
      else if (myWeb && d.canal === 'web') {
        const k = webKey(d);
        if (k && k.host === myWeb.host && k.path === myWeb.path && k.q === myWeb.q) motivos.push('misma_identidad_url_equivalente');
      }
    }
    if (motivos.length) { exactas.push(summary(row, motivos, 'exacta')); continue; }
    if (myWeb && d.canal === 'web') {
      const k = webKey(d);
      if (k && k.host === myWeb.host) motivos.push(k.path.startsWith(myWeb.path + '/') || myWeb.path.startsWith(k.path + '/') || !k.path || !myWeb.path ? 'ruta_anidada_mismo_dominio' : 'mismo_dominio');
    }
    const dName = normalizeName(d.nombre_entidad), dMun = normalizeName(d.municipio);
    if (myName && dName && (!myMun || !dMun || myMun === dMun) && (dName === myName || (Math.min(dName.length, myName.length) >= 12 && (dName.includes(myName) || myName.includes(dName))))) motivos.push('misma_entidad');
    if (motivos.length) parecidas.push(summary(row, motivos, 'revision'));
  }
  return { exactas, parecidas };
}

export async function buscarFuente(store, input, principal) {
  authorize(principal, null, 'read');
  const { url, usuario, nombre, municipio } = input;
  let canon = null;
  if (input.canal && (url || usuario || input.correo)) canon = canonicalSource(input);
  else if (url) {
    const host = (() => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } })();
    canon = canonicalSource({ canal: host === 'instagram.com' ? 'instagram' : host === 'tiktok.com' ? 'tiktok' : 'web', url });
  }
  // Sin canal: un usuario se busca como Instagram y como TikTok; un correo, como correo.
  let alterna = null;
  if (!canon && !input.canal && usuario) { canon = canonicalSource({ canal: 'instagram', usuario }); try { alterna = canonicalSource({ canal: 'tiktok', usuario }); } catch { alterna = null; } }
  else if (!canon && !input.canal && input.correo) canon = canonicalSource({ canal: 'correo', correo: input.correo });
  if (!canon && !nombre) fail('fuente_busqueda_vacia', { ayuda: 'Indica url, usuario (con o sin canal), correo o nombre (+municipio). Un usuario solo se busca en Instagram y TikTok; para web usa la url.' });
  const rows = await readRegistry(store);
  let { exactas, parecidas } = matchRegistry(canon, rows, { nombre, municipio });
  if (alterna) { const b = matchRegistry(alterna, rows, { nombre, municipio }); const ya = new Set(exactas.map(x => x.fuenteId)); exactas = [...exactas, ...b.exactas.filter(x => !ya.has(x.fuenteId))]; const yp = new Set([...ya, ...parecidas.map(x => x.fuenteId)]); parecidas = [...parecidas, ...b.parecidas.filter(x => !yp.has(x.fuenteId))]; }
  return { escaneadas: rows.length, exhaustivo: true, canonica: canon ? { ...canon, fuenteId: sourceId(canon.canal, canon.identificador) } : null, yaRegistrada: exactas.length > 0, exactas, parecidas: parecidas.slice(0, 20) };
}

// Campos de ficha nuevos (alta y actualización). undefined = no tocar; null = vaciar.
export function camposFicha(input) {
  const out = {};
  if (input.tipo !== undefined) out.tipo = input.tipo === null ? null : (TIPOS.includes(input.tipo) ? input.tipo : fail('fuente_tipo_invalido', { validos: TIPOS }));
  for (const k of ['comarca', 'zona']) if (input[k] !== undefined) out[k] = input[k] === null ? null : clean(input[k], 2, 120, `fuente_${k}_invalida`);
  if (input.redes !== undefined) {
    if (input.redes === null) out.redes = null;
    else {
      if (typeof input.redes !== 'object' || Array.isArray(input.redes)) fail('fuente_redes_invalidas', { validas: ['instagram', 'facebook', 'x', 'tiktok'] });
      const r = {};
      for (const [k, v] of Object.entries(input.redes)) { if (!['instagram', 'facebook', 'x', 'tiktok'].includes(k)) fail('fuente_redes_invalidas', { validas: ['instagram', 'facebook', 'x', 'tiktok'] }); if (v != null && v !== '') r[k] = clean(String(v), 2, 200, 'fuente_redes_invalidas'); }
      out.redes = Object.keys(r).length ? r : null;
    }
  }
  if (input.email !== undefined) out.email = input.email === null ? null : (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(input.email).trim()) && String(input.email).length <= 160 ? String(input.email).trim().toLowerCase() : fail('fuente_email_invalido'));
  if (input.telefono !== undefined) out.telefono = input.telefono === null ? null : (/^[+0-9 ().-]{6,25}$/.test(String(input.telefono).trim()) ? String(input.telefono).trim() : fail('fuente_telefono_invalido'));
  if (input.frecuenciaDias !== undefined) out.frecuencia_dias = Number.isInteger(input.frecuenciaDias) && input.frecuenciaDias >= 1 && input.frecuenciaDias <= 365 ? input.frecuenciaDias : fail('fuente_frecuencia_invalida', { ayuda: 'Entero de 1 a 365 días.' });
  if (input.notas !== undefined) out.notas = input.notas === null ? null : clean(input.notas, 1, 1000, 'fuente_notas_invalidas');
  if (input.responsable !== undefined) out.responsable = input.responsable === null ? null : (/^[a-z0-9_-]{2,40}$/i.test(String(input.responsable)) ? agenteCanonico(String(input.responsable)) : fail('fuente_responsable_invalido', { ayuda: 'Id del agente (2-40 caracteres: letras, números, guion).' }));
  return out;
}
const CODIGO_RE = /^F-[A-Z0-9]{2,6}-\d{3,5}$/;
function cleanCodigo(v) { if (typeof v !== 'string' || !CODIGO_RE.test(v.trim())) fail('fuente_codigo_invalido', { formato: 'F-XXX-0000 (p. ej. F-SAL-0001)' }); return v.trim(); }

export async function registrarFuente(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  authorize(principal, null, 'register_source');
  const canon = canonicalSource(input);
  const nombre = clean(input.nombreEntidad, 2, 160, 'fuente_nombre_invalido');
  const ambito = input.ambito == null ? 'municipio' : (AMBITOS.includes(normAmbito(input.ambito)) ? normAmbito(input.ambito) : fail('fuente_ambito_invalido', { validos: [...AMBITOS, 'ccaa'] }));
  const ficha_ = camposFicha(input);
  const region = (input.region ?? input.ccaa) == null ? null : clean(input.region ?? input.ccaa, 2, 120, 'fuente_region_invalida');
  // Una fuente sin municipio concreto (comarca, provincia, región, nacional) declara su ámbito en vez de inventar un municipio.
  const municipio = ambito === 'municipio' ? clean(input.municipio, 2, 120, 'fuente_municipio_requerido') : (input.municipio == null ? null : clean(input.municipio, 2, 120, 'fuente_municipio_requerido'));
  let provincia = input.provincia == null ? null : clean(input.provincia, 2, 120, 'fuente_provincia_invalida');
  let regionFinal = region, zonaDeducida = null;
  const filasZona = await readRegistry(store);
  // La zona (provincia o región) es obligatoria si la fuente no es de un municipio concreto; si falta, se deduce del municipio. Nunca se inventa.
  if (ambito !== 'municipio' && !regionFinal && !provincia) {
    const z = deducirZona({ municipio, filas: filasZona });
    if (!z) fail('fuente_ambito_sin_zona', { campoFaltante: 'region o provincia', ambito, municipioRecibido: municipio, ayuda: 'Una fuente de ámbito ' + ambito + ' necesita zona y no se ha podido deducir' + (municipio ? ' de «' + municipio + '»' : ' (no hay municipio)') + '. Pasa provincia (o region) con uno de los valores aceptados, o usa ambito="municipio" con el municipio concreto.', valoresAceptados: { provincias: PROVINCIAS, regiones: REGIONES, ambitos: AMBITOS } });
    provincia = z.provincia; regionFinal = z.region; zonaDeducida = { provincia: z.provincia, region: z.region, porque: z.origen };
  }
  // Con provincia conocida y sin región, la región se completa sola (p. ej. Zamora -> Castilla y León).
  if (provincia && !regionFinal) regionFinal = regionDeProvincia(provincia);
  if (provincia) { const k = reconocerZona(provincia); if (k?.tipo === 'provincia') provincia = k.provincia; }
  const categoria = input.categoria == null ? null : (/^[a-z_]{3,60}$/.test(input.categoria) ? input.categoria : fail('fuente_categoria_invalida'));
  const via = cleanVia(input.via);
  const id = sourceId(canon.canal, canon.identificador);
  const rows = filasZona, { exactas, parecidas } = matchRegistry(canon, filasZona, { nombre, municipio });
  // URL normalizada (sin protocolo, www, barra final ni tracking): misma URL = misma fuente, se rechaza y se devuelve el ID existente.
  const miClave = normalizarUrl(input.url);
  if (miClave) for (const r of rows) if (urlClave(r.data) === miClave && !exactas.some(e => e.fuenteId === r.id)) exactas.push(summary(r, ['misma_url_normalizada'], 'exacta'));
  if (input.url && esEnlaceSinResolver(input.url)) fail('fuente_url_sin_resolver', { ayuda: 'Es un enlace acortado o compartido (p. ej. share.google): ábrelo y registra la URL final de la página.' });
  if (exactas.length) return { registrada: false, rechazada: true, motivoRechazo: 'url_o_identidad_duplicada', yaExistia: true, fuenteId: exactas[0].fuenteId, fuente: exactas[0], mensaje: 'La fuente ya está registrada: no se ha escrito nada. No vuelvas a registrarla; usa su fuenteId.' };
  const codigo = input.codigo == null ? null : (authorize(principal, null, 'edit'), cleanCodigo(input.codigo));
  if (codigo) { const dupCod = rows.find(r => r.data.codigo === codigo); if (dupCod) fail('fuente_codigo_duplicado', { fuenteId: dupCod.id, codigo }); }
  // Solo se parece el nombre (misma entidad/dominio): se admite y se avisa de «posible duplicado». Nunca se borra ni se fusiona nada automáticamente.
  const avisos = parecidas.slice(0, 20).map(p => ({ tipo: 'posible_duplicado', fuenteId: p.fuenteId, codigo: p.codigo ?? null, nombre: p.nombreEntidad, municipio: p.municipio, motivos: p.motivos }));
  const motivo = input.motivo ? clean(input.motivo, 10, 500, 'fuente_motivo_requerido') : null;
  if (input.soloComprobar === true) return { registrada: false, disponible: true, fuenteId: id, canonica: canon, parecidas: parecidas.slice(0, 20), avisos, mensaje: 'Disponible para registrar. No se ha escrito nada (soloComprobar).' };
  const doc = {
    id, nombre_entidad: nombre, categoria, negocio_id: null, plan_solicitado: null, periodo_solicitado: null, contacto: null, consentimiento: null, incidencia: null, reclamaciones: [],
    ultima_revision: null, proxima_revision: null, ultimo_resultado: null, fallos_seguidos: 0, eventos_aportados: 0, claim: null,
    codigo, tipo: null, comarca: null, zona: null, url_normalizada: miClave || normalizarUrl(canon.url), redes: null, email: null, telefono: null, frecuencia_dias: FRECUENCIA_DEFECTO, responsable: agenteCanonico(principal.id), motivo_bloqueo: null, ultimo_evento_encontrado: null, notas: null,
    creada_por: agenteCanonico(principal.id), creada_por_principal: principal.id, modificada_por: agenteCanonico(principal.id), modificada_por_principal: principal.id, modificada_en: now(), ...ficha_,
    canal: canon.canal, identificador: canon.identificador, url: canon.url, municipio, provincia, ...(input.ambito != null || region || zonaDeducida ? { ambito, region: regionFinal } : {}), origen: 'asistente',
    via: `[${agenteCanonico(principal.id)}]${motivo ? ' (distinta de fuentes parecidas: ' + motivo + ')' : ''} ${via}`.slice(0, 900), estado: 'descubierta', creada_en: now(), fuera_de_territorio: input.fueraDeTerritorio === true
  };
  try { await store.write('registro_fuentes', id, doc, { create: true }); }
  catch (e) {
    if (e.code !== 'version_conflict') throw e;
    const again = await store.get('registro_fuentes', id);
    if (again) return { registrada: false, yaExistia: true, fuenteId: id, fuente: summary(again, ['misma_identidad'], 'exacta'), mensaje: 'Otra llamada la registró a la vez: no se ha duplicado.' };
    throw e;
  }
  return { registrada: true, fuenteId: id, codigo, estado: 'descubierta', responsable: doc.responsable, canonica: canon, ...(avisos.length ? { avisos } : {}), ...(zonaDeducida ? { zonaDeducida } : {}), mensaje: 'Fuente registrada. Aparece en el panel como «descubierta» y sin eventos aportados.' };
}

// Actualiza una fuente ya registrada: ubicación/ámbito, canal secundario y fusión de duplicados. Cada cambio queda en `historial`.
export async function actualizarFuente(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  authorize(principal, null, 'register_source');
  const motivo = clean(input.motivo, 10, 500, 'fuente_motivo_requerido');
  let id = clean(input.fuenteId, 8, 120, 'fuente_id_invalido');
  if (CODIGO_RE.test(id)) { const por = (await readRegistry(store)).find(r => r.data.codigo === id); if (!por) fail('fuente_no_encontrada', { codigo: id }); id = por.id; }
  const row = await store.get('registro_fuentes', id);
  if (!row) fail('fuente_no_encontrada', { fuenteId: id });
  if (row.data.estado === 'fusionada') fail('fuente_fusionada', { fuenteId: id, fusionadaEn: row.data.fusionada_en || null, ayuda: 'Esa fuente ya se fusionó en otra; actualiza la fuente destino.' });
  const d = structuredClone(row.data), cambios = [];
  const setField = (k, v) => { if (v !== undefined && d[k] !== v) { cambios.push({ campo: k, antes: d[k] ?? null, despues: v }); d[k] = v; } };
  if (input.nombreEntidad != null) setField('nombre_entidad', clean(input.nombreEntidad, 2, 160, 'fuente_nombre_invalido'));
  if (input.municipio !== undefined) setField('municipio', input.municipio === null ? null : clean(input.municipio, 2, 120, 'fuente_municipio_requerido'));
  if (input.provincia !== undefined) setField('provincia', input.provincia === null ? null : clean(input.provincia, 2, 120, 'fuente_provincia_invalida'));
  const regionIn = input.region !== undefined ? input.region : input.ccaa;
  if (regionIn !== undefined) setField('region', regionIn === null ? null : clean(regionIn, 2, 120, 'fuente_region_invalida'));
  if (input.ambito != null) setField('ambito', AMBITOS.includes(normAmbito(input.ambito)) ? normAmbito(input.ambito) : fail('fuente_ambito_invalido', { validos: [...AMBITOS, 'ccaa'] }));
  const nuevos = camposFicha(input);
  for (const [k, v] of Object.entries(nuevos)) setField(k, v);
  if (nuevos.frecuencia_dias !== undefined && d.ultima_revision) setField('proxima_revision', proximaRevision(d.ultima_revision, d.frecuencia_dias));
  if (input.estado !== undefined) {
    if (!ESTADOS.includes(input.estado)) fail('fuente_estado_invalido', { validos: ESTADOS });
    setField('estado', input.estado);
    if (input.estado === 'bloqueada') {
      const mb = input.motivoBloqueo;
      if (!mb || typeof mb !== 'object' || typeof mb.texto !== 'string' || mb.texto.trim().length < 5) fail('fuente_motivo_bloqueo_requerido', { ayuda: 'Una fuente bloqueada necesita motivoBloqueo {texto (≥5 caracteres), licenciaUrl? (https)} (p. ej. restricción de reutilización con el enlace a la licencia).' });
      let lic = null; if (mb.licenciaUrl != null && mb.licenciaUrl !== '') { lic = String(mb.licenciaUrl).trim(); if (!/^https:\/\/[^\s]+$/.test(lic) || lic.length > 500) fail('fuente_licencia_url_invalida'); }
      setField('motivo_bloqueo', { texto: clean(mb.texto, 5, 500, 'fuente_motivo_bloqueo_requerido'), licenciaUrl: lic });
    } else if (d.motivo_bloqueo) setField('motivo_bloqueo', null);
  } else if (input.motivoBloqueo !== undefined) fail('fuente_motivo_bloqueo_sin_estado', { ayuda: 'motivoBloqueo solo se guarda junto a estado="bloqueada".' });
  if (input.codigo !== undefined) {
    authorize(principal, null, 'edit');
    const cod = cleanCodigo(input.codigo);
    const dup = (await readRegistry(store)).find(r => r.data.codigo === cod && r.id !== id);
    if (dup) fail('fuente_codigo_duplicado', { fuenteId: dup.id, codigo: cod });
    setField('codigo', cod);
  }
  if ((d.ambito || 'municipio') === 'municipio' && !d.municipio) fail('fuente_municipio_requerido', { ayuda: 'Una fuente de ámbito municipio necesita municipio; si no lo tiene, cambia su ámbito (comarca, provincia, region, nacional) y pon region o provincia.' });
  if ((d.ambito || 'municipio') !== 'municipio' && !d.region && !d.provincia) fail('fuente_ambito_sin_zona', { ayuda: 'Una fuente sin municipio necesita region o provincia.' });
  const secundarios = Array.isArray(d.canales_secundarios) ? [...d.canales_secundarios] : [];
  const addSecundario = (canon, extra = {}) => {
    if (canon.canal === d.canal && canon.identificador === d.identificador) fail('fuente_canal_ya_es_principal', { fuenteId: id });
    if (!secundarios.some(x => x.canal === canon.canal && x.identificador === canon.identificador)) { secundarios.push({ canal: canon.canal, identificador: canon.identificador, url: canon.url, añadido_en: now(), ...extra }); cambios.push({ campo: 'canales_secundarios', antes: null, despues: `${canon.canal}:${canon.identificador}` }); }
  };
  if (input.canalSecundario) {
    const canon = canonicalSource(input.canalSecundario);
    const otra = await store.get('registro_fuentes', sourceId(canon.canal, canon.identificador));
    if (otra && otra.id !== id) fail('fuente_canal_ya_registrada', { fuenteId: otra.id, ayuda: 'Ese canal ya es una fuente registrada. Para unirlas usa fusionarDesde con su fuenteId.' });
    addSecundario(canon);
  }
  let absorbida = null;
  if (input.fusionarDesde) {
    authorize(principal, null, 'edit');
    const otherId = clean(input.fusionarDesde, 8, 120, 'fuente_id_invalido');
    if (otherId === id) fail('fuente_fusion_invalida', { ayuda: 'No se puede fusionar una fuente consigo misma.' });
    const other = await store.get('registro_fuentes', otherId);
    if (!other) fail('fuente_no_encontrada', { fuenteId: otherId });
    if (other.data.estado === 'fusionada') fail('fuente_fusionada', { fuenteId: otherId, fusionadaEn: other.data.fusionada_en || null });
    addSecundario({ canal: other.data.canal, identificador: other.data.identificador, url: other.data.url || '' }, { fuenteIdAnterior: otherId });
    for (const x of Array.isArray(other.data.canales_secundarios) ? other.data.canales_secundarios : []) if (!(x.canal === d.canal && x.identificador === d.identificador) && !secundarios.some(y => y.canal === x.canal && y.identificador === x.identificador)) secundarios.push(x);
    setField('eventos_aportados', (Number(d.eventos_aportados) || 0) + (Number(other.data.eventos_aportados) || 0));
    absorbida = other;
  }
  if (!cambios.length) return { actualizada: false, fuenteId: id, mensaje: 'No hay cambios: la fuente ya tenía esos valores.' };
  if (secundarios.length) d.canales_secundarios = secundarios;
  d.modificada_por = agenteCanonico(principal.id); d.modificada_por_principal = principal.id; d.modificada_en = now();
  d.historial = [...(Array.isArray(d.historial) ? d.historial : []), { en: now(), por: agenteCanonico(principal.id), principal: principal.id, motivo, cambios }].slice(-25);
  await store.write('registro_fuentes', id, d, { updateTime: row.updateTime });
  if (absorbida) {
    const o = structuredClone(absorbida.data);
    o.estado = 'fusionada'; o.fusionada_en = id; o.fusionada_por = agenteCanonico(principal.id); o.fusionada_el = now();
    o.historial = [...(Array.isArray(o.historial) ? o.historial : []), { en: now(), por: agenteCanonico(principal.id), principal: principal.id, motivo, cambios: [{ campo: 'estado', antes: absorbida.data.estado ?? null, despues: 'fusionada' }] }].slice(-25);
    try { await store.write('registro_fuentes', absorbida.id, o, { updateTime: absorbida.updateTime }); }
    catch (e) { return { actualizada: true, fuenteId: id, cambios, avisoFusion: 'La fuente destino se actualizó pero la absorbida no se pudo marcar como fusionada (' + (e.code || e.message) + '). Repite la fusión.' }; }
  }
  return { actualizada: true, fuenteId: id, cambios, ...(absorbida ? { fusionada: absorbida.id } : {}), mensaje: 'Fuente actualizada. Los eventos ya admitidos conservan su procedencia original.' };
}
