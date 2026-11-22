// limpieza_aplicar.mjs — ejecución APROBADA de la limpieza única. Por defecto simula; --aplicar escribe.
//   1) retira (retirada lógica y recuperable) los duplicados exactos aprobados, conservando la copia con más datos;
//   2) rellena fuente_tipo=oficial y fuente_nombre en eventos de programas oficiales acreditados.
// Excluye lo no aprobado: grupos de prueba («test event») y fechas malformadas. Omite cualquier evento con piezas editoriales.
import { FirestoreStore } from './firestore-store.mjs';
import { EventService } from './event-service.mjs';
import { normalizeText } from './event-domain.mjs';
const APLICAR = process.argv.includes('--aplicar');
const noPiezas = new Set(JSON.parse(process.env.EVENTOS_CON_PIEZAS || '[]'));
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
let actual = null;   // la imagen ya guardada se conserva tal cual: este script no descarga ni cambia imágenes
const events = new EventService(store, { get: () => ({ url: actual.image ?? actual.imagen ?? null, sourceUrl: actual.sourceImageUrl ?? actual.image ?? null }) });
const rows = []; let cursor = null;
for (;;) { const p = await store.list('eventos', { cursor, limit: 500 }); rows.push(...p); if (p.length < 500) break; cursor = p.at(-1).id; }
const OCULTO = /cancel|retirad|pend|rechaz|borr|oculto/i;
const publicado = d => d.retirado !== true && d.activa !== false && d.prueba !== true && !OCULTO.test(String(d.estado || ''));
const g = (d, ...ks) => { for (const k of ks) if (d[k] != null && d[k] !== '') return d[k]; return null; };
const fecha = d => g(d, 'fechaLocal', 'fecha_inicio') || (d.dateTime ? String(d.dateTime).slice(0, 10) : null);
const rellenos = d => Object.values(d).filter(v => v != null && v !== '' && !(Array.isArray(v) && !v.length)).length;
const grupos = new Map();
for (const r of rows.filter(r => publicado(r.data))) {
  const d = r.data, k = [normalizeText(g(d, 'titulo', 'nombre')), normalizeText(g(d, 'city', 'ciudad') || (typeof d.ubicacion === 'string' ? d.ubicacion : '')), fecha(d), g(d, 'horaLocal', 'hora') || '', normalizeText(g(d, 'lugar', 'place') || '')].join('|');
  if (!k.startsWith('|')) (grupos.get(k) || grupos.set(k, []).get(k)).push(r);
}
const plan = { retirar: [], excluidos: [], conPiezas: [], fuente: [] };
for (const a of [...grupos.values()].filter(a => a.length > 1)) {
  const orden = [...a].sort((x, y) => rellenos(y.data) - rellenos(x.data) || (x.id < y.id ? -1 : 1)), titulo = g(orden[0].data, 'titulo', 'nombre');
  if (/test event/i.test(titulo) || !/^\d{4}-\d{2}-\d{2}$/.test(fecha(orden[0].data) || '')) { plan.excluidos.push({ titulo, copias: a.length }); continue; }
  for (const r of orden.slice(1)) { const item = { eventId: r.id, negocioId: r.data.negocioId, titulo, conserva: orden[0].id, version: r.data.version || 0 }; (noPiezas.has(r.id) || noPiezas.has(orden[0].id) ? plan.conPiezas : plan.retirar).push(item); }
}
for (const r of rows.filter(r => publicado(r.data) && !(r.data.fuente_tipo && r.data.fuente_nombre) && (r.data.programEvidence || r.data.procedenciaRegistro || r.data.programAncestorResolution) && (r.data.fuentes || []).length)) {
  const n = await store.get('negocios', r.data.negocioId), nombre = String(n?.data.nombre || n?.data.name || '').trim().slice(0, 80);
  if (nombre) plan.fuente.push({ eventId: r.id, negocioId: r.data.negocioId, version: r.data.version || 0, fuente_nombre: nombre });
}
console.log(JSON.stringify({ modo: APLICAR ? 'APLICAR' : 'simulación', retirar: plan.retirar.length, excluidosPorPrueba_o_fecha: plan.excluidos, omitidosPorPiezas: plan.conPiezas.length, rellenarFuente: plan.fuente.length, detalle: { retirar: plan.retirar, fuente: plan.fuente } }, null, 1));
if (!APLICAR) process.exit(0);
const lim = { id: 'limpieza-catalogo', actions: ['retire', 'complete'], businesses: ['*'] }, res = { retirados: [], fuente: [], errores: [] };
for (const it of plan.retirar) {
  try {
    const v = await events.retirePreview({ eventId: it.eventId, negocioId: it.negocioId }, lim);
    await events.retire({ eventId: it.eventId, negocioId: it.negocioId, expectedVersion: v.versionActual, codigoConfirmacion: v.codigoConfirmacion, motivo: `Duplicado exacto de ${it.conserva} (limpieza única aprobada, 13-11-2026)` }, lim);
    res.retirados.push(it.eventId);
  } catch (e) { res.errores.push({ eventId: it.eventId, error: e.code || String(e) }); }
}
for (const it of plan.fuente) {
  try { actual = (await store.get('eventos', it.eventId)).data; const r = await events.complete({ eventId: it.eventId, negocioId: it.negocioId, expectedVersion: it.version, campos: { fuente_tipo: 'oficial', fuente_nombre: it.fuente_nombre }, motivo: 'Programa oficial acreditado: fuente_tipo oficial (limpieza única aprobada)' }, lim); res.fuente.push({ eventId: it.eventId, completado: r.completado }); }
  catch (e) { res.errores.push({ eventId: it.eventId, error: e.code || String(e) }); }
}
console.log('RESULTADO ' + JSON.stringify(res));
