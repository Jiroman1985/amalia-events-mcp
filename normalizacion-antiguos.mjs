// normalizacion-antiguos.mjs — plan puro (sin E/S) para normalizar fechaLocal, municipio (city) y provincia en eventos antiguos.
// Solo RELLENA huecos con datos que ya constan en el propio documento (o, para la provincia, que coinciden en TODOS los eventos canónicos del mismo municipio).
// Nunca pisa un valor existente ni inventa: lo dudoso se informa en `omitidos` para revisión.
import { claveNombre } from './dedup_amalia.mjs';
import { municipioClave } from './clave-sesion.mjs';

const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
// Provincia inferida solo si al menos este número de eventos del catálogo con provincia respaldan el municipio.
const MIN_RESPALDO = 2;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const valida = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const pad = n => String(n).padStart(2, '0');
/** Fecha local (YYYY-MM-DD) que consta en un documento antiguo y de dónde sale; null + motivo si no se puede fijar sin ambigüedad. */
export function fechaDeAntiguo(d) {
  const fi = typeof d.fecha_inicio === 'string' ? d.fecha_inicio.trim() : '';
  if (ISO.test(fi) && valida(+fi.slice(0, 4), +fi.slice(5, 7), +fi.slice(8, 10))) return { fecha: fi, origen: 'fecha_inicio' };
  const dt = typeof d.dateTime === 'string' ? d.dateTime.trim() : '';
  if (dt) {
    let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(dt);
    if (m && valida(+m[1], +m[2], +m[3])) {
      // Un instante UTC («Z») puede caer en otro día en hora local: ambiguo salvo que sea solo fecha o lleve desfase explícito.
      if (/Z$/i.test(dt)) return { fecha: null, motivo: 'dateTime_utc_ambiguo' };
      return { fecha: `${m[1]}-${m[2]}-${m[3]}`, origen: 'dateTime_iso' };
    }
    // Texto en español: solo si es una fecha (o un rango/lista de días del mismo mes) y se sabe el INICIO. «Hasta el…» o «a partir del…» no son la fecha de inicio: se omiten.
    const mes = x => MESES[x.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')];
    if (/\b(hasta|a partir|desde)\b/i.test(dt)) return { fecha: null, motivo: 'dateTime_texto_sin_inicio' };
    m = /^(?:durante\s+el\s+fin\s+de\s+semana\s+d(?:el|e)\s+|del\s+)?(\d{1,2})(?:\s*(?:-|–|y|al|a)\s*\d{1,2})?\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})(?:\s*,\s*.*)?$/i.exec(dt);
    if (m && mes(m[2]) && valida(+m[3], mes(m[2]), +m[1])) return { fecha: `${m[3]}-${pad(mes(m[2]))}-${pad(+m[1])}`, origen: 'dateTime_texto' };
    return { fecha: null, motivo: 'dateTime_no_interpretable' };
  }
  return { fecha: null, motivo: 'sin_fecha' };
}
const texto = v => (typeof v === 'string' ? v.trim() : '');
/** Municipio que consta en el documento (city, ciudad, town, ubicacion como texto u objeto.municipio). */
export function municipioDeAntiguo(d) {
  for (const v of [d.city, d.ciudad, d.town, typeof d.ubicacion === 'string' ? d.ubicacion : null, d.ubicacion && typeof d.ubicacion === 'object' ? d.ubicacion.municipio : null]) { const t = texto(v); if (t) return t; }
  return null;
}
/** Provincia por municipio: solo si todos los eventos con provincia y ese municipio (clave con alias) coinciden. */
export function tablaProvincias(rows) {
  const por = new Map();
  for (const r of rows) {
    const d = r.data || r, prov = texto(d.provincia) || texto(d.ubicacion && typeof d.ubicacion === 'object' ? d.ubicacion.provincia : '');
    const c = municipioDeAntiguo(d); if (!prov || !c) continue;
    const k = municipioClave(c); if (!k) continue;
    const m = por.get(k) || new Map(); m.set(prov, (m.get(prov) || 0) + 1); por.set(k, m);
  }
  const out = new Map();
  for (const [k, m] of por) if (m.size === 1) { const [prov, n] = [...m.entries()][0]; out.set(k, { provincia: prov, respaldo: n }); }
  return out;
}
/** rows: [{id,data,updateTime}]. Devuelve {cambios:[{id,version,updateTime,antes,despues,origen}], omitidos:{motivo:n}, resumen}. */
export function planNormalizacion(rows) {
  const provPorMuni = tablaProvincias(rows), cambios = [], omitidos = {}, omite = (m, id) => { (omitidos[m] ||= []).push(id); };
  const resumen = { total: rows.length, yaNormalizados: 0, conCambios: 0, fechaLocal: 0, city: 0, provincia: 0, porOrigenFecha: {} };
  for (const r of rows) {
    const d = r.data, despues = {}, antes = {}, origen = {};
    if (d.fechaLocal == null || d.fechaLocal === '') {
      const f = fechaDeAntiguo(d);
      if (f.fecha) { despues.fechaLocal = f.fecha; antes.fechaLocal = d.fechaLocal ?? null; origen.fechaLocal = f.origen; resumen.porOrigenFecha[f.origen] = (resumen.porOrigenFecha[f.origen] || 0) + 1; }
      else omite('fecha_' + f.motivo, r.id);
    } else if (typeof d.fecha_inicio === 'string' && ISO.test(d.fecha_inicio) && d.fecha_inicio !== d.fechaLocal) omite('fecha_inicio_distinta_de_fechaLocal', r.id);
    if (!texto(d.city)) {
      const c = municipioDeAntiguo(d);
      if (c) { despues.city = c; antes.city = d.city ?? null; origen.city = 'municipio_en_otro_campo'; } else omite('sin_municipio', r.id);
    }
    if (!texto(d.provincia)) {
      const c = despues.city || texto(d.city) || municipioDeAntiguo(d), objProv = texto(d.ubicacion && typeof d.ubicacion === 'object' ? d.ubicacion.provincia : '');
      if (objProv) { despues.provincia = objProv; antes.provincia = d.provincia ?? null; origen.provincia = 'ubicacion.provincia'; }
      else if (c && provPorMuni.has(municipioClave(c)) && provPorMuni.get(municipioClave(c)).respaldo >= MIN_RESPALDO) { despues.provincia = provPorMuni.get(municipioClave(c)).provincia; antes.provincia = d.provincia ?? null; origen.provincia = 'unica_del_municipio'; }
      else if (c && provPorMuni.has(municipioClave(c))) omite('provincia_poco_respaldada', r.id);
      else omite(c ? 'provincia_desconocida' : 'provincia_sin_municipio', r.id);
    }
    const ks = Object.keys(despues);
    if (!ks.length) { resumen.yaNormalizados++; continue; }
    resumen.conCambios++; for (const k of ks) resumen[k]++;
    cambios.push({ id: r.id, version: d.version || 0, updateTime: r.updateTime, antes, despues, origen });
  }
  return { cambios, omitidos: Object.fromEntries(Object.entries(omitidos).map(([k, v]) => [k, { n: v.length, ejemplos: v.slice(0, 5) }])), resumen };
}

/** Escribe el plan en lotes atómicos (versión+1, auditoría, guardia del catálogo). Un lote que falla no impide los siguientes; se informa. */
export async function aplicarPlan(store, plan, { lote = 100, now = new Date().toISOString() } = {}) {
  const resultado = { ok: 0, fallos: [] };
  for (let i = 0; i < plan.cambios.length; i += lote) {
    const tanda = plan.cambios.slice(i, i + lote);
    try {
      const guard = await store.get('amalia_catalog_guard', 'eventos');
      if (!guard?.updateTime || !Number.isSafeInteger(guard.data.epoch)) throw Object.assign(new Error('catalog_guard_unavailable'), { code: 'catalog_guard_unavailable' });
      const items = tanda.map(c => {
        const patch = { ...c.despues, version: c.version + 1, normalizacion_backfill_v1: { at: now, campos: Object.keys(c.despues), origen: c.origen } };
        return { key: c.id, data: patch, updateTime: c.updateTime, updateFields: Object.keys(patch), audit: { version: patch.version, actor: 'backfill', actorPrincipal: 'backfill_normalizar', action: 'normalizado_antiguo', reason: 'Normalizar fechaLocal, municipio y provincia de eventos antiguos', at: now, before: { version: c.version, ...c.antes }, after: patch } };
      });
      await store.writeMany(items, { guard: { updateTime: guard.updateTime, epoch: guard.data.epoch } });
      resultado.ok += tanda.length;
    } catch (e) { resultado.fallos.push({ desde: tanda[0].id, n: tanda.length, error: e.code || e.message }); }
  }
  return resultado;
}
