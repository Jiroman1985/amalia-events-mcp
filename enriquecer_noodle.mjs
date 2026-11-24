// enriquecer_noodle.mjs — rellena coordenadas e imagen de los eventos ACTIVOS creados por noodle. ENSAYO por defecto: no escribe nada.
//   node enriquecer_noodle.mjs --salida plan.json [--html ejemplos.html] [--cache geocache.json] [--limite N]
//   node enriquecer_noodle.mjs --aplicar --plan plan.json --confirmo <huella> [--lote 100] [--incluir-dudosas]
// 1) Geocodifica «recinto, municipio, provincia» (o solo «municipio, provincia» si no hay recinto) con OpenStreetMap Nominatim. Un recinto solo vale si cae a menos de 30 km del municipio;
//    si no, se usa el municipio (tipo «municipio»). Guarda geoUbicacion + geo/geo_precision/geo_fuente como el resto del catálogo.
// 2) Si la URL de la fuente NO es la portada del dominio, descarga la página y toma og:image (o twitter:image, JSON-LD, <img> principal), valida que carga, que es PNG/JPEG/WEBP,
//    que no es un logo ni la imagen por defecto del sitio, y la rellena (image, imagen, sourceImageUrl: enlace a la imagen de la fuente, no copia).
// 3) Los que enlazan a la portada quedan con enriquecer_pendiente=true para que Noodle los arregle a mano.
// Nunca pisa datos existentes. Aplicar escribe el plan aprobado (misma huella), con versión+1, auditoría y guardia del catálogo; vuelve a leer cada documento y solo rellena lo que siga vacío.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import zlib from 'node:zlib';
import { FirestoreStore } from './firestore-store.mjs';
import { publicAddress, imageType } from './media-store.mjs';
import { geoCampos } from './event-domain.mjs';
import { validarPar } from './catalogo-compartido.mjs';

const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const aplicar = process.argv.includes('--aplicar');
const AUTOR = 'noodle', UA = 'AMALIA-enriquecer/1.0';
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const norm = s => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hoyMadrid = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

// ---------- estado de los eventos ----------
const tieneGeo = d => Boolean(d.geo || d.geoUbicacion || (d.lat != null && d.lng != null));
const tieneImagen = d => Boolean(d.image || d.imagen || d.sourceImageUrl || d.assetId);
const urlDelEvento = d => d.link || d.fuentes?.[0]?.url || d.enlace_original || null;
/** true si la URL es la portada del dominio (sin ruta ni parámetros) o no es una URL válida. */
function esPortada(u) {
  try { const x = new URL(u); return x.pathname.replace(/\/+$/, '') === '' && !x.search; } catch { return true; }
}
const huellaDe = cambios => createHash('sha256').update(JSON.stringify(cambios.map(c => [c.id, c.despues]))).digest('hex').slice(0, 16);
const GUARDIA = async () => { const g = await store.get('amalia_catalog_guard', 'eventos'); if (!g?.updateTime || !Number.isSafeInteger(g.data.epoch)) throw Object.assign(new Error('catalog_guard_unavailable'), { code: 'catalog_guard_unavailable' }); return { updateTime: g.updateTime, epoch: g.data.epoch }; };

// ---------- escritura (solo --aplicar) ----------
/** Parche a partir del documento ACTUAL: solo rellena lo que sigue vacío (nunca pisa). */
function parche(plan, d) {
  const despues = {}, antes = {};
  if (plan.despues.geoUbicacion && !tieneGeo(d)) { const g = plan.despues.geoUbicacion; Object.assign(despues, { geoUbicacion: g, ...geoCampos(g) }); antes.geoUbicacion = null; }
  if (plan.despues.image && !tieneImagen(d)) { Object.assign(despues, { image: plan.despues.image, imagen: plan.despues.image, sourceImageUrl: plan.despues.image, imagenOrigenUrl: plan.imagenInfo?.pagina || null }); antes.image = null; }
  if (plan.despues.enriquecer_pendiente && !tieneImagen(d) && d.enriquecer_pendiente !== true) { despues.enriquecer_pendiente = true; antes.enriquecer_pendiente = d.enriquecer_pendiente ?? null; }
  return { despues, antes };
}
async function aplicarPlan(cambios, { lote, now = new Date().toISOString() }) {
  const r = { escritos: 0, sinCambios: 0, retirados: 0, fallos: [], versionSaltada: [] };
  const items = [];
  for (const c of cambios) {
    const cur = await store.get('eventos', c.id);
    if (!cur) { r.fallos.push({ id: c.id, error: 'no_existe' }); continue; }
    if (cur.data.retirado === true) { r.retirados++; continue; }
    const p = parche(c, cur.data);
    if (!Object.keys(p.despues).length) { r.sinCambios++; continue; }
    const version = (cur.data.version || 0) + 1;
    const marca = { at: now, campos: Object.keys(p.despues).filter(k => !['geo', 'geo_precision', 'geo_fuente', 'lat', 'lng', 'imagen', 'sourceImageUrl', 'imagenOrigenUrl'].includes(k)), origen: c.origen };
    const data = { ...p.despues, version, enriquecimiento_noodle_v1: marca };
    items.push({ key: c.id, data, updateTime: cur.updateTime, updateFields: Object.keys(data), audit: { version, actor: 'backfill', actorPrincipal: 'enriquecer_noodle', action: 'enriquecido_noodle', reason: 'Rellenar coordenadas e imagen de eventos de noodle (huecos; no se pisa nada)', at: now, before: { version: cur.data.version || 0, ...p.antes }, after: data } });
  }
  for (let i = 0; i < items.length; i += lote) {
    const tanda = items.slice(i, i + lote);
    try { await store.writeMany(tanda, { guard: await GUARDIA() }); r.escritos += tanda.length; continue; } catch (e) { if (tanda.length === 1 && e.code !== 'version_conflict') { r.fallos.push({ id: tanda[0].key, error: e.code || e.message }); continue; } }
    for (const it of tanda) { // reintento uno a uno
      try {
        let v = it.data.version;
        for (let k = 0; k < 5 && await store.get('eventos/' + it.key + '/revisiones', 'v' + String(v).padStart(8, '0')); k++) v++;
        const data = { ...it.data, version: v }, audit = { ...it.audit, version: v, after: data };
        await store.writeMany([{ ...it, data, audit, updateFields: Object.keys(data) }], { guard: await GUARDIA() });
        r.escritos++; if (v !== it.data.version) r.versionSaltada.push({ id: it.key, version: v });
      } catch (e) { r.fallos.push({ id: it.key, error: e.code || e.message }); }
    }
  }
  return r;
}
if (aplicar) {
  const f = arg('plan'); if (!f || f === true) { console.error('Indica --plan <fichero del ensayo>'); process.exit(2); }
  const plan = JSON.parse(readFileSync(f, 'utf8'));
  const cambios = [...plan.cambios, ...(process.argv.includes('--incluir-dudosas') ? plan.dudosas.map(d => d.cambio).filter(Boolean) : [])];
  if (arg('confirmo') !== plan.huella || huellaDe(plan.cambios) !== plan.huella) { console.error(`La huella no coincide (plan ${plan.huella}): solo se aplica el plan aprobado en el ensayo.`); process.exit(2); }
  const lote = Math.min(Math.max(Number(arg('lote')) || 100, 1), 200);
  console.log(JSON.stringify({ modo: 'APLICADO', huella: plan.huella, ...await aplicarPlan(cambios, { lote }) }, null, 1));
  process.exit(0);
}

// ---------- red segura (misma política que la descarga de imágenes: sin hosts privados, https, límites) ----------
async function pedir(url, { max, accept, redirects = 0 }) {
  let u; try { u = new URL(url); } catch { throw new Error('url_invalida'); }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:') throw new Error('no_https');
  if (redirects > 4) throw new Error('demasiadas_redirecciones');
  let addrs; try { addrs = await lookup(u.hostname, { all: true }); } catch { throw new Error('dns'); }
  if (!addrs.length || addrs.some(a => !publicAddress(a.address))) throw new Error('host_privado');
  const a = addrs.find(x => x.family === 4) || addrs[0];
  return new Promise((resolve, reject) => {
    const req = https.get(u, { family: a.family, autoSelectFamily: false, lookup: (_h, o, cb) => process.nextTick(() => o?.all ? cb(null, [a]) : cb(null, a.address, a.family)), headers: { 'user-agent': UA, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'es-ES,es;q=0.9' }, timeout: 12000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); pedir(new URL(res.headers.location, u).href, { max, accept, redirects: redirects + 1 }).then(resolve, reject); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('http_' + res.statusCode)); return; }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const out = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = []; let size = 0;
      out.on('data', c => { size += c.length; if (size > max) { req.destroy(); reject(new Error('demasiado_grande')); } else chunks.push(c); });
      out.on('end', () => resolve({ bytes: Buffer.concat(chunks), finalUrl: u.href, contentType: String(res.headers['content-type'] || '') }));
      out.on('error', () => reject(new Error('lectura')));
    });
    let agotado = false; req.on('error', e => reject(new Error(agotado ? 'timeout' : /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(e.code)) ? 'certificado' : 'red')));
    req.on('timeout', () => { agotado = true; req.destroy(); });
  });
}
const colas = new Map(); // un host cada vez y con pausa: no se castiga a las webs pequeñas
const porHost = (host, fn) => { const prev = colas.get(host) || Promise.resolve(); const p = prev.then(async () => { try { return await fn(); } finally { await sleep(350); } }); colas.set(host, p.catch(() => {})); return p; };

// ---------- geocodificación (Nominatim: 1 petición/s, caché en disco) ----------
const cachePath = arg('cache') || 'geocache.json';
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
let ultima = 0;
async function nominatim(q) {
  if (q in cache) return cache[q];
  const espera = ultima + 1100 - Date.now(); if (espera > 0) await sleep(espera); ultima = Date.now();
  let r = null;
  try {
    const { bytes } = await pedir('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'jsonv2', limit: '4', countrycodes: 'es', addressdetails: '1' }), { max: 500_000, accept: 'application/json' });
    r = JSON.parse(bytes.toString('utf8')).map(x => ({ lat: +x.lat, lng: +x.lon, nombre: x.display_name, clase: x.category, tipo: x.type, importancia: x.importance }));
  } catch (e) { return { error: e.message }; }
  cache[q] = r; return r;
}
const km = (a, b) => { const R = 6371, t = x => x * Math.PI / 180, dLa = t(b.lat - a.lat), dLo = t(b.lng - a.lng), h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const munis = new Map(), alias = Object.fromEntries(String(arg('alias') || '').split(',').filter(Boolean).map(x => x.split('=').map(y => y.trim())));
// --alias "Palacios Rubios=Palaciosrubios": grafía con la que OpenStreetMap conoce el municipio (solo para la consulta; el evento no cambia).
async function municipio(city, prov) {
  const k = norm(city) + '|' + norm(prov); if (munis.has(k)) return munis.get(k);
  const p = (async () => {
    const res = await nominatim(`${alias[city] || city}, ${prov}, España`); if (res.error) return { error: res.error };
    const bien = res.filter(x => norm(x.nombre).includes(norm(prov)) && ['boundary', 'place'].includes(x.clase));
    const x = bien[0]; return x ? { lat: x.lat, lng: x.lng, nombre: x.nombre } : { error: 'sin_resultado_municipio' };
  })();
  munis.set(k, p); return p;
}
/** Recinto (si lo hay y es distinto del municipio) o municipio. Devuelve {geoUbicacion, motivo?} */
async function geocodificar(d) {
  const city = (d.city || d.town || '').trim(), prov = (d.provincia || '').trim();
  if (!city) return { motivo: 'sin_municipio' };
  const m = await municipio(city, prov); if (m.error) return { motivo: m.error };
  const lugar = (d.lugar || '').trim(), recinto = lugar && !norm(city).includes(norm(lugar)) && !norm(lugar).includes(norm(city)) ? lugar.split(/\s\/\s|\s+-\s+/)[0].replace(/\(.*?\)/g, '').trim() : '';
  const base = { fuente: 'OpenStreetMap Nominatim (geocodificación automática)', comprobadoEn: hoyMadrid() };
  if (recinto) {
    const res = await nominatim(`${recinto}, ${city}, ${prov}, España`);
    const ok = !res.error && res.find(x => norm(x.nombre).includes(norm(prov)) && km(x, m) <= 30);
    if (ok) return { geoUbicacion: { lat: ok.lat, lng: ok.lng, tipo: 'recinto', ...base, fuente: base.fuente + ' · ' + recinto }, nombre: ok.nombre };
    const g = validarPar(m.lat, m.lng); if (!g.ok) return { motivo: 'coordenadas_invalidas' };
    return { geoUbicacion: { lat: m.lat, lng: m.lng, tipo: 'municipio', ...base }, nombre: m.nombre, recintoNoEncontrado: recinto };
  }
  const g = validarPar(m.lat, m.lng); if (!g.ok) return { motivo: 'coordenadas_invalidas' };
  return { geoUbicacion: { lat: m.lat, lng: m.lng, tipo: 'municipio', ...base }, nombre: m.nombre };
}

// ---------- imágenes ----------
const attrs = tag => { const o = {}; for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) o[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&'); return o; };
const NOMBRE_LOGO = /(^|[\/_.\-])(logo|logotipo|favicon|icon|iconos?|sprite|avatar|placeholder|default|escudo|isotipo|marca|header|cabecera|banner-?web|blank|pixel|spacer|loading)([\/_.\-0-9]|$)/i;
/** Candidatas de imagen de una página, por orden de fiabilidad. */
function candidatasDe(html, base) {
  const out = [], add = (u, via) => { if (!u) return; try { const x = new URL(u.trim(), base).href; if (!out.some(o => o.url === x)) out.push({ url: x, via }); } catch { /* url rota */ } };
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => attrs(m[0]));
  for (const k of ['og:image:secure_url', 'og:image', 'og:image:url']) for (const a of metas) if ((a.property || a.name) === k) add(a.content, 'og:image');
  for (const a of metas) if (['twitter:image', 'twitter:image:src'].includes(a.name || a.property)) add(a.content, 'twitter:image');
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) { const a = attrs(m[0]); if (/image_src/i.test(a.rel || '')) add(a.href, 'image_src'); }
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const v = JSON.parse(m[1]); const buscar = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(buscar); const im = o.image; for (const i of [].concat(im || [])) add(typeof i === 'string' ? i : i?.url, 'json-ld'); Object.values(o).forEach(buscar); }; buscar(v); } catch { /* json-ld mal formado */ }
  }
  const cuerpo = (/<(main|article)\b[\s\S]*<\/\1>/i.exec(html) || [html])[0];
  for (const m of cuerpo.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]), src = a['data-src'] || a['data-lazy-src'] || (a.srcset || a['data-srcset'] || '').split(',').map(s => s.trim().split(/\s+/)).sort((x, y) => parseInt(y[1] || 0) - parseInt(x[1] || 0))[0]?.[0] || a.src;
    if (!src || src.startsWith('data:') || NOMBRE_LOGO.test(new URL(src, base).pathname) || /logo|icon|avatar/i.test(a.class || '' + a.alt || '')) continue;
    if ((+a.width || 999) < 200 || (+a.height || 999) < 120) continue;
    add(src, 'img');
  }
  return out;
}
/** Tamaño (px) leído de la cabecera PNG/JPEG/WEBP; null si no se puede. */
function dimensiones(b) {
  try {
    if (b[0] === 0x89) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff) { let i = 2; while (i < b.length - 9) { if (b[i] !== 0xff) { i++; continue; } const t = b[i + 1], len = b.readUInt16BE(i + 2); if (t >= 0xc0 && t <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(t)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + len; } return null; }
    if (b.subarray(0, 4).toString() === 'RIFF') { const f = b.subarray(12, 16).toString(); if (f === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }; if (f === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }; if (f === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; } }
  } catch { /* cabecera truncada */ }
  return null;
}
const paginas = new Map(), imagenes = new Map(), defectoHost = new Map();
const hostDe = u => { try { return new URL(u).host; } catch { return ''; } };
function pagina(url) {
  if (!paginas.has(url)) paginas.set(url, porHost(hostDe(url), async () => {
    try { const r = await pedir(url, { max: 3_000_000, accept: 'text/html,application/xhtml+xml' }); if (!/html|xml/i.test(r.contentType) && !/^\s*</.test(r.bytes.subarray(0, 200).toString())) return { error: 'no_html' }; return { candidatas: candidatasDe(r.bytes.toString('utf8'), r.finalUrl), finalUrl: r.finalUrl }; }
    catch (e) { return { error: e.message }; }
  }));
  return paginas.get(url);
}
/** Imagen por defecto del sitio (la de su portada): si coincide, es genérica y no vale. */
function defectoDe(host) {
  if (!defectoHost.has(host)) defectoHost.set(host, (async () => { const p = await pagina('https://' + host + '/'); return new Set((p.candidatas || []).filter(c => c.via !== 'img').map(c => c.url)); })());
  return defectoHost.get(host);
}
function validar(url) {
  if (!imagenes.has(url)) imagenes.set(url, porHost(hostDe(url), async () => {
    if (NOMBRE_LOGO.test((() => { try { return new URL(url).pathname; } catch { return ''; } })())) return { ok: false, motivo: 'parece_logo_por_nombre' };
    let r; try { r = await pedir(url, { max: 8_000_000, accept: 'image/png,image/jpeg,image/webp,image/*;q=0.5' }); } catch (e) { return { ok: false, motivo: 'no_carga_' + e.message }; }
    let t; try { t = imageType(r.bytes); } catch { return { ok: false, motivo: 'formato_no_admitido' }; }
    const dim = dimensiones(r.bytes); if (!dim) return { ok: false, motivo: 'sin_dimensiones' };
    const { w, h } = dim, aspecto = w / h;
    if (w < 400 || h < 250) return { ok: false, motivo: 'muy_pequena', w, h };
    if (aspecto > 3.2 || aspecto < 0.3) return { ok: false, motivo: 'proporcion_de_banner_o_logo', w, h };
    return { ok: true, url: r.finalUrl, w, h, mime: t.mime, kb: Math.round(r.bytes.length / 1024), sha: createHash('sha256').update(r.bytes).digest('hex').slice(0, 16), dudosa: w === h && w <= 640 ? 'cuadrada_pequena' : null };
  }));
  return imagenes.get(url);
}
async function imagenDe(url) {
  const p = await pagina(url); if (p.error) return { motivo: 'pagina_' + p.error };
  if (!p.candidatas.length) return { motivo: 'pagina_sin_imagen' };
  const defecto = await defectoDe(hostDe(url)), motivos = [];
  for (const c of p.candidatas.slice(0, 6)) {
    if (defecto.has(c.url)) { motivos.push('imagen_por_defecto_del_sitio'); continue; }
    const v = await validar(c.url); if (v.ok) return { imagen: v.url, via: c.via, ...v };
    motivos.push(v.motivo);
  }
  return { motivo: motivos[0] || 'sin_valida', motivos: [...new Set(motivos)] };
}

// ---------- ensayo ----------
const rows = await store.listAll('eventos', { max: 100000 });
let objetivo = rows.filter(r => (r.data?.createdBy === AUTOR || r.data?.agenteCanonico === AUTOR) && r.data.retirado !== true && (!tieneGeo(r.data) || !tieneImagen(r.data)));
const ids = arg('ids') ? new Set(String(arg('ids')).split(',')) : null; if (ids) objetivo = objetivo.filter(r => ids.has(r.id));
const soloGeo = process.argv.includes('--solo-geo');
const lim = Number(arg('limite')); if (lim) objetivo = objetivo.slice(0, lim);
const compartida = new Map(); for (const r of objetivo) { const u = urlDelEvento(r.data); if (u) compartida.set(u, (compartida.get(u) || 0) + 1); }
const resumen = { eventosActivosDeNoodle: rows.filter(r => r.data?.createdBy === AUTOR && r.data.retirado !== true).length, aRevisar: objetivo.length, sinCoordenadas: 0, sinImagen: 0, coordenadas: { recinto: 0, municipio: 0, municipio_porque_no_se_hallo_el_recinto: 0, sinResultado: {} }, imagen: { aplicables: 0, dudosas: 0, sinImagenValida: {}, porPortada_pendiente: 0, yaTenianImagen: 0 }, eventosConAlgunCambio: 0 };
const cambios = [], dudosas = [], sinResolver = [], hechos = [];
let n = 0;
for (const r of objetivo) {
  const d = r.data, c = { id: r.id, titulo: d.titulo, municipio: d.city, provincia: d.provincia, lugar: d.lugar || null, version: d.version || 0, updateTime: r.updateTime, antes: {}, despues: {}, origen: {} };
  if (!tieneGeo(d)) {
    resumen.sinCoordenadas++; const g = await geocodificar(d);
    if (g.geoUbicacion) { c.despues.geoUbicacion = g.geoUbicacion; c.origen.geo = g.recintoNoEncontrado ? 'municipio_recinto_no_hallado' : g.geoUbicacion.tipo; c.geoNombre = g.nombre; resumen.coordenadas[g.recintoNoEncontrado ? 'municipio_porque_no_se_hallo_el_recinto' : g.geoUbicacion.tipo]++; }
    else { resumen.coordenadas.sinResultado[g.motivo] = (resumen.coordenadas.sinResultado[g.motivo] || 0) + 1; sinResolver.push({ id: r.id, campo: 'geo', motivo: g.motivo }); }
  }
  let dudosa = null;
  if (soloGeo) { /* solo coordenadas */ } else if (!tieneImagen(d)) {
    resumen.sinImagen++; const u = urlDelEvento(d);
    if (!u || esPortada(u)) { c.despues.enriquecer_pendiente = true; c.origen.imagen = 'portada_pendiente_para_noodle'; resumen.imagen.porPortada_pendiente++; }
    else {
      const im = await imagenDe(u);
      if (im.imagen) { c.despues.image = im.imagen; c.origen.imagen = im.via; c.imagenInfo = { url: im.imagen, pagina: u, via: im.via, w: im.w, h: im.h, kb: im.kb, mime: im.mime, sha: im.sha }; hechos.push(c); dudosa = im.dudosa || (compartida.get(u) >= 4 ? 'pagina_compartida_por_' + compartida.get(u) + '_eventos' : null); }
      else { resumen.imagen.sinImagenValida[im.motivo] = (resumen.imagen.sinImagenValida[im.motivo] || 0) + 1; sinResolver.push({ id: r.id, campo: 'imagen', motivo: im.motivo, pagina: u }); }
    }
  } else if (!soloGeo) resumen.imagen.yaTenianImagen++;
  if (++n % 25 === 0) console.error(`  ${n}/${objetivo.length}…`);
  if (!Object.keys(c.despues).length) continue;
  if (dudosa) { const { image, ...resto } = c.despues; dudosas.push({ id: c.id, motivo: dudosa, imagen: c.imagenInfo, cambio: c }); if (Object.keys(resto).length) cambios.push({ ...c, despues: resto }); continue; }
  cambios.push(c);
}
// la misma imagen en ≥4 eventos de páginas distintas = genérica: pasa a dudosas
const porSha = new Map(); for (const c of hechos) porSha.set(c.imagenInfo.sha, [...(porSha.get(c.imagenInfo.sha) || []), c]);
for (const [, g] of porSha) if (g.length >= 4 && new Set(g.map(c => c.imagenInfo.pagina)).size > 1) for (const c of g) { const x = cambios.find(y => y.id === c.id); if (x?.despues.image) { const { image, ...resto } = x.despues; dudosas.push({ id: c.id, motivo: 'misma_imagen_en_' + g.length + '_eventos', imagen: c.imagenInfo, cambio: x }); if (Object.keys(resto).length) x.despues = resto; else cambios.splice(cambios.indexOf(x), 1); } }
resumen.imagen.aplicables = cambios.filter(c => c.despues.image).length; resumen.imagen.dudosas = dudosas.length; resumen.eventosConAlgunCambio = cambios.length;
const huella = huellaDe(cambios);
// 10 ejemplos de imagen: webs distintas primero
const ejemplos = []; const vistos = new Set();
for (const c of cambios.filter(c => c.despues.image)) { const h = hostDe(c.imagenInfo.pagina); if (!vistos.has(h) && ejemplos.length < 10) { vistos.add(h); ejemplos.push(c); } }
for (const c of cambios.filter(c => c.despues.image)) if (ejemplos.length < 10 && !ejemplos.includes(c)) ejemplos.push(c);
const informe = { generado: new Date().toISOString(), modo: 'ENSAYO (no se ha escrito nada)', huella, resumen, ejemplosImagen: ejemplos.map(c => ({ id: c.id, titulo: c.titulo, municipio: c.municipio, ...c.imagenInfo })), ejemplosCoordenadas: cambios.filter(c => c.despues.geoUbicacion).slice(0, 8).map(c => ({ id: c.id, titulo: c.titulo, lugar: c.lugar, municipio: c.municipio, tipo: c.despues.geoUbicacion.tipo, lat: c.despues.geoUbicacion.lat, lng: c.despues.geoUbicacion.lng, osm: c.geoNombre })), dudosas: dudosas.slice(0, 15).map(d => ({ id: d.id, motivo: d.motivo, imagen: d.imagen?.url })), sinResolver: sinResolver.slice(0, 20) };
const salida = arg('salida'); if (salida) writeFileSync(salida, JSON.stringify({ ...informe, cambios, dudosas, sinResolver }, null, 1));
writeFileSync(cachePath, JSON.stringify(cache));
const html = arg('html');
if (html) writeFileSync(html, `<!doctype html><meta charset="utf-8"><title>Ensayo enriquecer_noodle: 10 imágenes</title><style>body{font:14px system-ui;margin:20px;background:#fafafa}figure{display:inline-block;width:330px;margin:8px;vertical-align:top;background:#fff;padding:8px;border:1px solid #ddd;border-radius:8px}img{width:100%;height:210px;object-fit:cover;background:#eee}figcaption{font-size:12px;margin-top:6px}</style><h2>10 imágenes del ensayo (huella ${huella})</h2>${ejemplos.map(c => `<figure><img src="${c.imagenInfo.url}" loading="lazy"><figcaption><b>${c.titulo}</b><br>${c.municipio} · ${c.imagenInfo.w}×${c.imagenInfo.h} ${c.imagenInfo.mime} ${c.imagenInfo.kb} KB · vía ${c.imagenInfo.via}<br><a href="${c.imagenInfo.pagina}">página de la fuente</a></figcaption></figure>`).join('')}`);
console.log(JSON.stringify(informe, null, 1));
