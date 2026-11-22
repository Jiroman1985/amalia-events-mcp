// limpieza_dominio.mjs — fuente_tipo=oficial a eventos cuyo dominio de fuente principal es institucional (aprobado). Simula por defecto; --aplicar escribe.
// fuente_nombre solo si el nombre del negocio es claramente institucional; si no, se deja para los agentes (no se inventa).
import { FirestoreStore } from './firestore-store.mjs';
import { EventService } from './event-service.mjs';
import { esFuenteComprobacion } from './event-domain.mjs';
const APLICAR = process.argv.includes('--aplicar');
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
let actual = null;
const events = new EventService(store, { get: () => ({ url: actual.image ?? actual.imagen ?? null, sourceUrl: actual.sourceImageUrl ?? actual.image ?? null }) });
const rows = []; let cursor = null;
for (;;) { const p = await store.list('eventos', { cursor, limit: 500 }); rows.push(...p); if (p.length < 500) break; cursor = p.at(-1).id; }
const OCULTO = /cancel|retirad|pend|rechaz|borr|oculto/i;
const publicado = d => d.retirado !== true && d.activa !== false && d.prueba !== true && !OCULTO.test(String(d.estado || ''));
const hostDe = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const OFICIAL = /(^|\.)(gob\.es|gva\.es|jcyl\.es|juntadeandalucia\.es|madrid\.org|xunta\.gal|euskadi\.eus|navarra\.es|larioja\.org|jccm\.es|castillalamancha\.es|aragon\.es|cantabria\.es|asturias\.es|carm\.es|canarias\.org|gobiernodecanarias\.org|gobcan\.es|caib\.es|gencat\.cat|ajuntament\w*\.cat|dipu\w*\.es|diputacion\w*\.\w+|dip-\w+\.es|cabildo\w*\.\w+|ayto-?\w*\.\w+|aytos?\.\w+|ayuntamiento\w*\.\w+)$/i;
const INSTITUCIONAL = /ayuntamiento|ayto\.?|diputaci[oó]n|cabildo|junta de|consejer[ií]a|gobierno|xunta|generalitat|concello|universidad|patronato/i;
const plan = [], negocios = new Map();
for (const r of rows.filter(r => publicado(r.data) && !(r.data.fuente_tipo))) {
  const d = r.data, u = (d.fuentes || []).map(s => s?.url).filter(Boolean).find(u => !esFuenteComprobacion(u)) || d.enlace_original || d.link, h = hostDe(u);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(d.negocioId || '') || !(d.fuentes || []).length || !h || !OFICIAL.test(h) || d.programEvidence || d.procedenciaRegistro) continue;
  if (!negocios.has(d.negocioId)) { const n = await store.get('negocios', d.negocioId); negocios.set(d.negocioId, String(n?.data.nombre || n?.data.name || '').trim().slice(0, 80)); }
  const nombre = negocios.get(d.negocioId), campos = { fuente_tipo: 'oficial' }; if (nombre && INSTITUCIONAL.test(nombre) && !d.fuente_nombre) campos.fuente_nombre = nombre;
  plan.push({ eventId: r.id, negocioId: d.negocioId, version: d.version || 0, host: h, campos });
}
const hosts = {}; for (const p of plan) hosts[p.host] = (hosts[p.host] || 0) + 1;
console.log(JSON.stringify({ modo: APLICAR ? 'APLICAR' : 'simulación', eventos: plan.length, conNombre: plan.filter(p => p.campos.fuente_nombre).length, hosts: Object.entries(hosts).sort((a, b) => b[1] - a[1]) }));
if (!APLICAR) process.exit(0);
const lim = { id: 'limpieza-catalogo', actions: ['complete'], businesses: ['*'] }, res = { ok: 0, sinCambios: 0, errores: [] };
for (const p of plan) {
  try { actual = (await store.get('eventos', p.eventId)).data; const r = await events.complete({ eventId: p.eventId, negocioId: p.negocioId, expectedVersion: actual.version || 0, campos: p.campos, motivo: 'fuente_tipo oficial por dominio institucional (limpieza única aprobada, 13-11-2026)' }, lim); r.completado ? res.ok++ : res.sinCambios++; }
  catch (e) { res.errores.push({ eventId: p.eventId, error: e.code || String(e) }); }
}
console.log('RESULTADO ' + JSON.stringify(res));
