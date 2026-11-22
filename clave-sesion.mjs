// clave-sesion.mjs — clave canónica por sesión (municipio + fecha + hora + recinto). El título NO forma parte de la clave.
// Módulo puro: lo usan el alta atómica, la cola de revisión, el backfill y la auditoría nocturna.
import { hash } from './event-domain.mjs';
import { claveNombre, leg, horaDe, nombreParecido, terminosNombre } from './dedup_amalia.mjs';

const GENERICAS = new Set(['de','del','la','las','el','los','y','plaza','auditorio','casa','cultura','centro','cultural','salon','sala','municipal','polideportivo','pabellon','parque','iglesia','ayuntamiento','calle','avenida','paseo','teatro','biblioteca','museo']);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Recinto normalizado: minúsculas, sin tildes/signos, sin artículos ni genéricos SOLO si queda algún término; vacío si es el propio municipio. */
export function recintoClave(lugar, city) {
  const full = claveNombre(lugar);
  if (!full || full === claveNombre(city)) return '';
  const rest = full.split(' ').filter(t => t && !GENERICAS.has(t));
  return rest.length ? rest.join(' ') : full;
}
/** URL comparable: sin esquema, sin www, sin parámetros de rastreo, sin barra final ni fragmento. */
export function normalizarUrl(u) {
  try {
    const x = new URL(String(u));
    const host = x.hostname.toLowerCase().replace(/^www\./, '');
    const params = [...x.searchParams].filter(([k]) => !/^(utm_|fbclid$|gclid$|igshid$|ref$)/i.test(k)).sort(([a], [b]) => (a < b ? -1 : 1));
    const q = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return host + x.pathname.replace(/\/+$/, '') + q;
  } catch { return String(u || '').trim().toLowerCase(); }
}
const ciudadDe = d => leg(d, 'city', 'ciudad') || (typeof d.ubicacion === 'string' ? d.ubicacion : d.ubicacion?.municipio);
const lugarDe = d => leg(d, 'lugar', 'recinto', 'venue') || (d.ubicacion && typeof d.ubicacion === 'object' ? d.ubicacion.lugar : null);

/** Clave de UNA sesión. null si falta municipio o fecha ISO (no se inventa nada). */
export function claveSesion({ city, lugar, fechaLocal, horaLocal, discriminador = '' }) {
  const municipio = claveNombre(city);
  if (!municipio || !ISO.test(String(fechaLocal || ''))) return null;
  const hora = HORA.test(String(horaLocal || '')) ? horaLocal : null;
  const recinto = recintoClave(lugar, city);
  const fuerza = hora && recinto ? 'fuerte' : (hora || recinto ? 'media' : 'debil');
  const clave = [municipio, fechaLocal, hora || 'sin_hora', recinto].join('|') + (discriminador ? '|#' + claveNombre(discriminador) : '');
  return { municipio, fecha: fechaLocal, hora, recinto, discriminador: discriminador || '', fuerza, clave, municipioFecha: municipio + '|' + fechaLocal };
}
/** Sesiones de un evento (sesiones[] + fecha principal). */
export function sesionesDeEvento(d) {
  const f = leg(d, 'fechaLocal', 'fecha_inicio') || (typeof d.dateTime === 'string' ? d.dateTime.slice(0, 10) : null);
  const lista = Array.isArray(d.sesiones) && d.sesiones.length ? d.sesiones.map(s => ({ fechaLocal: s.fechaLocal, horaLocal: s.horaLocal || null })) : [];
  if (f && !lista.some(s => s.fechaLocal === f)) lista.unshift({ fechaLocal: f, horaLocal: horaDe(d) });
  return lista;
}
/**
 * Documentos de `sesiones_clave` de un evento. ID: hash de la clave si es FUERTE (único en todo el catálogo);
 * si no, el ID incluye el eventId (nunca colisiona, pero sirve de índice por municipioFecha).
 */
export function clavesDeEvento(eventId, d, { discriminador = '' } = {}) {
  const out = [];
  for (const s of sesionesDeEvento(d)) {
    const k = claveSesion({ city: ciudadDe(d), lugar: lugarDe(d), fechaLocal: s.fechaLocal, horaLocal: s.horaLocal, discriminador: discriminador || d.discriminadorSesion || '' });
    if (!k) continue;
    const fuerte = k.fuerza === 'fuerte';
    const id = 'sk_' + hash(k.clave + (fuerte ? '' : '\0' + eventId)).slice(0, 40);
    if (out.some(o => o.id === id)) continue;
    out.push({ id, fuerte, data: { eventId, negocioId: d.negocioId || null, clave: k.clave, fuerza: k.fuerza, municipio: k.municipio, fecha: k.fecha, hora: k.hora, recinto: k.recinto, municipioFecha: k.municipioFecha, titulo: claveNombre(leg(d, 'titulo', 'nombre')), tituloOriginal: leg(d, 'titulo', 'nombre') || null, urlNorm: d.fuentes?.[0]?.url ? normalizarUrl(d.fuentes[0].url) : null, discriminador: k.discriminador, at: new Date().toISOString() } });
  }
  return out;
}
/** Títulos equivalentes o muy parecidos (mismo criterio que la regla vigente: igualdad, inclusión/Levenshtein, solape de términos). */
export function tituloParecido(a, b) {
  const ca = claveNombre(a), cb = claveNombre(b);
  if (!ca || !cb) return false;
  if (ca === cb || nombreParecido(ca, cb)) return true;
  const ta = terminosNombre(a), tb = terminosNombre(b), inter = [...ta].filter(t => tb.has(t)).length;
  return inter >= 2 && inter / Math.min(ta.size, tb.size) >= 0.8;
}
export const tituloIgual = (a, b) => { const ca = claveNombre(a), cb = claveNombre(b); return !!ca && ca === cb; };
/** Recintos compatibles: iguales o uno contenido en el otro (por términos). Vacío = no distingue. */
export function recintosCompatibles(a, b) {
  if (!a || !b || a === b) return true;
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' ')), [pq, gr] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return [...pq].every(t => gr.has(t));
}
/**
 * Decide qué hacer con una sesión candidata frente a los vecinos del mismo municipio y fecha.
 *  decision: 'libre' | 'bloquea' | 'cola'. Cada motivo lleva el eventId vecino.
 * Reglas (el título nunca forma parte de la clave, solo ayuda a decidir):
 *  - misma clave FUERTE: bloquea si el título es parecido; si no, cola (aunque la URL coincida: una página de programa lista varias obras) (¿dos obras en el mismo recinto y hora?).
 *  - título IGUAL y horas distintas y presentes en ambos: es otra sesión → libre.
 *  - título parecido (no igual): recinto compatible y horas iguales/ausentes → bloquea si ambas con hora y recinto, si no cola.
 *  - sin hora frente a con hora, o recinto/hora distintos, con título parecido → cola.
 */
export function decidirSesion(cand, vecinos, { eventId = null } = {}) {
  const motivos = [];
  for (const v of vecinos) {
    if (!v || (eventId && v.eventId === eventId)) continue;
    const mismaClave = cand.fuerza === 'fuerte' && v.clave === cand.clave;
    const parecido = tituloParecido(cand.titulo, v.tituloOriginal || v.titulo), igual = tituloIgual(cand.titulo, v.tituloOriginal || v.titulo);
    const mismaUrl = !!cand.urlNorm && cand.urlNorm === v.urlNorm;
    if (mismaClave) { motivos.push({ eventId: v.eventId, decision: parecido ? 'bloquea' : 'cola', motivo: parecido ? 'misma_clave_fuerte' : (mismaUrl ? 'misma_clave_misma_url_titulo_distinto' : 'misma_clave_titulo_distinto'), clave: v.clave }); continue; }
    if (!parecido) continue;
    const horasDistintas = cand.hora && v.hora && cand.hora !== v.hora;
    if (igual && horasDistintas) continue; // misma obra en otro pase del mismo día
    const rc = recintosCompatibles(cand.recinto, v.recinto);
    if (!horasDistintas && rc && !(!cand.hora !== !v.hora)) { motivos.push({ eventId: v.eventId, decision: cand.hora && cand.recinto && v.recinto ? 'bloquea' : (igual ? 'bloquea' : 'cola'), motivo: igual ? 'mismo_titulo_misma_sesion' : 'titulo_parecido_misma_sesion' }); continue; }
    motivos.push({ eventId: v.eventId, decision: 'cola', motivo: !cand.hora !== !v.hora ? 'sin_hora_frente_a_con_hora' : horasDistintas ? 'titulo_parecido_hora_distinta' : 'titulo_parecido_recinto_distinto' });
  }
  const decision = motivos.some(m => m.decision === 'bloquea') ? 'bloquea' : motivos.length ? 'cola' : 'libre';
  return { decision, motivos };
}
