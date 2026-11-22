// fuentes-modelo.mjs — modelo único de fuentes (colección `registro_fuentes`, ampliada de forma aditiva: el panel actual sigue funcionando).
// Campos nuevos respecto al registro anterior: codigo, tipo, comarca, zona, url_normalizada, redes, email, telefono, frecuencia_dias,
// proxima_revision, responsable, motivo_bloqueo, ultimo_evento_encontrado, notas, creada_por, modificada_por, modificada_en.
// `region` es la CCAA; `eventos_aportados` es «eventos encontrados».
import { agenteCanonico } from './identidad.mjs';
export const TIPOS = ['ayuntamiento', 'bando', 'agenda', 'teatro', 'asociacion', 'negocio', 'redes', 'diputacion', 'medio', 'plataforma', 'turismo', 'museo', 'restauracion', 'organizador', 'particular', 'otro'];
// descubierta = recién registrada y sin validar (estado histórico del panel); se trata como activa. fusionada la fija el sistema.
export const ESTADOS = ['descubierta', 'activa', 'pausada', 'bloqueada', 'descartada'];
export const ESTADOS_REVISABLES = new Set(['descubierta', 'activa', 'pausada', undefined, null]);
export const FRECUENCIA_DEFECTO = 7;
export const DIA_MS = 86400000;
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|yclid|igshid|igsh|mc_cid|mc_eid|_ga|_gl|ref|ref_src|ref_url|si|spm|share|shared|fb_source|wt_mc|cmpid|hl|g_st|lang|locale|entry|g_ep)$/i;
// Redes y agregadores: la identidad es el perfil; la query nunca la distingue.
const SIN_QUERY = /^(instagram\.com|tiktok\.com|facebook\.com|m\.facebook\.com|x\.com|twitter\.com|youtube\.com|linktr\.ee|wa\.me)$/;
const SHORT_UNRESOLVED = /(^|\.)(share\.google|g\.co|goo\.gl|maps\.app\.goo\.gl|bit\.ly|t\.co|lnkd\.in|tinyurl\.com)$/i;

/** URL normalizada: sin protocolo, sin www, sin barra final, sin fragmento ni parámetros de tracking, parámetros restantes ordenados. null si no es una URL http(s). */
export function normalizarUrl(value) {
  if (value == null) return null;
  let s = String(value).trim(); if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, ''); if (!host.includes('.')) return null;
  const path = decodeURIComponent(u.pathname.replace(/\/+$/, '') || '').toLowerCase();
  const params = SIN_QUERY.test(host) ? (/facebook\.com$/.test(host) && /\/profile\.php$/.test(path) && u.searchParams.get('id') ? [['id', u.searchParams.get('id')]] : []) : [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a, x], [b, y]) => a === b ? (x < y ? -1 : 1) : (a < b ? -1 : 1));
  const q = params.length ? '?' + params.map(([k, v]) => `${k.toLowerCase()}=${v.trim().toLowerCase()}`).join('&') : '';
  return `${host}${path}${q}`;
}
/** Enlaces acortados/compartidos que no se pueden usar como identidad hasta resolverlos (p. ej. share.google). */
export const esEnlaceSinResolver = value => { try { return SHORT_UNRESOLVED.test(new URL(String(value).trim()).hostname); } catch { return false; } };
/** Clave de URL de un registro: la guardada o, en registros antiguos, la calculada desde su url. */
export const urlClave = d => d?.url_normalizada || normalizarUrl(d?.url) || null;
export const frecuenciaDe = d => { const n = Number(d?.frecuencia_dias); return Number.isFinite(n) && n >= 1 ? n : FRECUENCIA_DEFECTO; };
export const proximaRevision = (ultima, frecuenciaDias) => { const t = Date.parse(ultima); return Number.isFinite(t) ? new Date(t + frecuenciaDias * DIA_MS).toISOString() : null; };
/** Estado efectivo de revisión de un registro (sin escribir nada). */
export function estadoRevision(d, ahora = Date.now()) {
  const activa = ESTADOS_REVISABLES.has(d.estado) && d.estado !== 'pausada';
  const ultima = d.ultima_revision || null, proxima = d.proxima_revision || (ultima ? proximaRevision(ultima, frecuenciaDe(d)) : null);
  const sinRevisar = !ultima, vencida = activa && (sinRevisar || (proxima && Date.parse(proxima) <= ahora));
  return { activa, sinRevisar: activa && sinRevisar, vencida: !!vencida, proxima, diasDesdeRevision: ultima ? Math.floor((ahora - Date.parse(ultima)) / DIA_MS) : null };
}
export const zonaDe = d => d.zona || d.region || d.provincia || null;
/** Ficha uniforme de lectura (acepta documentos antiguos y nuevos). */
export function ficha(row, ahora = Date.now()) {
  const d = row.data || row, r = estadoRevision(d, ahora);
  return {
    fuenteId: row.id, codigo: d.codigo ?? null, nombre: d.nombre_entidad ?? null, tipo: d.tipo ?? null, ambito: d.ambito ?? 'municipio',
    ccaa: d.region ?? null, provincia: d.provincia ?? null, comarca: d.comarca ?? null, municipio: d.municipio ?? null, zona: d.zona ?? null,
    canal: d.canal ?? null, url: d.url || null, urlNormalizada: urlClave(d), redes: d.redes ?? null, email: d.email ?? null, telefono: d.telefono ?? null,
    frecuenciaDias: frecuenciaDe(d), ultimaRevision: d.ultima_revision ?? null, proximaRevision: r.proxima, vencida: r.vencida, sinRevisar: r.sinRevisar,
    responsable: d.responsable ? agenteCanonico(d.responsable) : null, estado: d.estado ?? null, motivoBloqueo: d.motivo_bloqueo ?? null,
    eventosEncontrados: Number(d.eventos_aportados) || 0, ultimoEventoEncontrado: d.ultimo_evento_encontrado ?? null,
    origen: d.origen ?? null, notas: d.notas ?? null, creadaPor: d.creada_por ? agenteCanonico(d.creada_por) : null, creadaEn: d.creada_en ?? null, modificadaPor: d.modificada_por ? agenteCanonico(d.modificada_por) : null, modificadaEn: d.modificada_en ?? null
  };
}
