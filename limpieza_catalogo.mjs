// limpieza_catalogo.mjs — SOLO LECTURA. Recuento y muestra de lo que haría la limpieza única del catálogo (punto 5).
// No importa ninguna función de escritura: aprobar la ejecución es un paso posterior y separado.
// Uso (dentro del contenedor): node limpieza_catalogo.mjs [--muestra=5]
import { FirestoreStore } from './firestore-store.mjs';
import { normalizeText, esFuenteComprobacion } from './event-domain.mjs';

const muestra = Number((process.argv.find(a => a.startsWith('--muestra=')) || '--muestra=5').split('=')[1]);
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const rows = []; let cursor = null;
for (;;) { const page = await store.list('eventos', { cursor, limit: 500 }); rows.push(...page); if (page.length < 500) break; cursor = page.at(-1).id; }
const negocios = new Map(); cursor = null;
for (;;) { const page = await store.list('negocios', { cursor, limit: 500 }); for (const n of page) negocios.set(n.id, n.data); if (page.length < 500) break; cursor = page.at(-1).id; }

const OCULTO = /cancel|retirad|pend|rechaz|borr|oculto/i;
const publicado = d => d.retirado !== true && d.activa !== false && d.prueba !== true && !OCULTO.test(String(d.estado || ''));
const g = (d, ...ks) => { for (const k of ks) if (d[k] != null && d[k] !== '') return d[k]; return null; };
const fecha = d => g(d, 'fechaLocal', 'fecha_inicio') || (d.dateTime ? String(d.dateTime).slice(0, 10) : null);
const hostDe = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const fuentesDe = d => (d.fuentes || []).map(s => s?.url).filter(Boolean);
const fuentePrincipal = d => fuentesDe(d).find(u => !esFuenteComprobacion(u)) || g(d, 'enlace_original', 'link');
const rellenos = d => Object.values(d).filter(v => v != null && v !== '' && !(Array.isArray(v) && !v.length)).length;

const pub = rows.filter(r => publicado(r.data));
const out = { totalDocumentos: rows.length, publicados: pub.length, retiradosOOcultos: rows.length - pub.length };

// 1. Duplicados exactos: mismo título normalizado, municipio, día, hora y lugar.
const grupos = new Map();
for (const r of pub) {
  const d = r.data, k = [normalizeText(g(d, 'titulo', 'nombre')), normalizeText(g(d, 'city', 'ciudad') || (typeof d.ubicacion === 'string' ? d.ubicacion : '')), fecha(d), g(d, 'horaLocal', 'hora') || '', normalizeText(g(d, 'lugar', 'place') || '')].join('|');
  if (!k.startsWith('|')) (grupos.get(k) || grupos.set(k, []).get(k)).push(r);
}
const dups = [...grupos.values()].filter(a => a.length > 1);
out.duplicadosExactos = {
  grupos: dups.length, eventosARetirar: dups.reduce((n, a) => n + a.length - 1, 0),
  muestra: dups.slice(0, muestra).map(a => { const orden = [...a].sort((x, y) => rellenos(y.data) - rellenos(x.data) || (x.id < y.id ? -1 : 1)); return { titulo: g(orden[0].data, 'titulo', 'nombre'), fecha: fecha(orden[0].data), conservaria: { id: orden[0].id, camposRellenos: rellenos(orden[0].data) }, retiraria: orden.slice(1).map(r => ({ id: r.id, camposRellenos: rellenos(r.data) })) }; }),
};
const retirables = new Set(dups.flatMap(a => [...a].sort((x, y) => rellenos(y.data) - rellenos(x.data) || (x.id < y.id ? -1 : 1)).slice(1).map(r => r.id)));

// 2. Carencias de los que se quedan, agrupadas por fuente principal.
const vivos = pub.filter(r => !retirables.has(r.id));
const carencias = {
  sinHora: d => !g(d, 'horaLocal', 'hora'),
  sinRecintoExacto: d => d.geo_precision !== 'lugar',
  sinCategoria: d => !(d.categorias?.length) && !g(d, 'categoria', 'category'),
  sinPrecio: d => (d.precio == null) && (d.precioEstado == null || d.precioEstado === 'desconocido'),
};
out.carencias = {};
for (const [nombre, f] of Object.entries(carencias)) {
  const lista = vivos.filter(r => f(r.data)), porFuente = new Map();
  for (const r of lista) { const h = hostDe(fuentePrincipal(r.data)) || '(sin fuente)'; porFuente.set(h, (porFuente.get(h) || 0) + 1); }
  out.carencias[nombre] = { eventos: lista.length, porcentaje: +(100 * lista.length / Math.max(vivos.length, 1)).toFixed(1), principalesFuentes: [...porFuente].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([host, n]) => ({ host, n })), muestra: lista.slice(0, muestra).map(r => ({ id: r.id, titulo: g(r.data, 'titulo', 'nombre'), fuente: hostDe(fuentePrincipal(r.data)) })) };
}

// 3. fuente_tipo / fuente_nombre.
const OFICIAL = /(^|\.)(gob\.es|gva\.es|jcyl\.es|juntadeandalucia\.es|madrid\.org|xunta\.gal|euskadi\.eus|navarra\.es|larioja\.org|jccm\.es|castillalamancha\.es|aragon\.es|cantabria\.es|asturias\.es|carm\.es|canarias\.org|gobiernodecanarias\.org|gobcan\.es|caib\.es|gencat\.cat|cat|dipu\w*\.es|diputacion\w*\.\w+|dip-\w+\.es|cabildo\w*\.\w+|ayto-?\w*\.\w+|aytos?\.\w+|ayuntamiento\w*\.\w+)$/i;
const PLATAFORMA = /(^|\.)(eventbrite\.\w+|ticketmaster\.\w+|entradas\.com|fever\w*\.com|meetup\.com|facebook\.com|instagram\.com|tiktok\.com|atrapalo\.com|dice\.fm|ticketea\.com|oferplan\.com|todoplanes\.com|passline\.com|wegow\.com|entradium\.com|tickentradas\.com|servientradas\.com)$/i;
const conFuentes = vivos.filter(r => fuentesDe(r.data).length);
const sinNinguna = vivos.filter(r => !fuentesDe(r.data).length && !g(r.data, 'enlace_original', 'link'));
const yaTienen = conFuentes.filter(r => r.data.fuente_tipo && r.data.fuente_nombre);
const clases = { programaOficialAcreditado: [], dominioOficial: [], plataforma: [], sinClasificarPorDominio: [] };
for (const r of conFuentes.filter(r => !(r.data.fuente_tipo && r.data.fuente_nombre))) {
  const d = r.data, h = hostDe(fuentePrincipal(d));
  if (d.programEvidence || d.procedenciaRegistro || d.programAncestorResolution) clases.programaOficialAcreditado.push(r);
  else if (h && OFICIAL.test(h)) clases.dominioOficial.push(r);
  else if (h && PLATAFORMA.test(h)) clases.plataforma.push(r);
  else clases.sinClasificarPorDominio.push(r);
}
const nombreNegocio = r => (negocios.get(r.data.negocioId)?.nombre || negocios.get(r.data.negocioId)?.name || '').slice(0, 80);
const conNombre = a => a.filter(r => nombreNegocio(r)).length;
out.fuente = {
  eventosConFuentes: conFuentes.length, eventosConFuentes_todosLosDocumentos: rows.filter(r => fuentesDe(r.data).length).length, sinFuentesNiEnlace_todosLosDocumentos: rows.filter(r => !fuentesDe(r.data).length && !g(r.data, 'enlace_original', 'link')).length, yaTienenFuenteTipoYNombre: yaTienen.length, eventosSinFuentesNiEnlaceDeOrigen: sinNinguna.length,
  recibirianFuenteTipo_oficial_porPrograma: { n: clases.programaOficialAcreditado.length, conNombreDelNegocio: conNombre(clases.programaOficialAcreditado) },
  recibirianFuenteTipo_oficial_porDominio: { n: clases.dominioOficial.length, conNombreDelNegocio: conNombre(clases.dominioOficial), nota: 'Propuesta por patrón de dominio (gob.es, ayto*, ayuntamiento*, diputación…): requiere tu visto bueno antes de aplicarse.', muestra: clases.dominioOficial.slice(0, muestra).map(r => hostDe(fuentePrincipal(r.data))) },
  recibirianFuenteTipo_plataforma: { n: clases.plataforma.length, conNombreDelNegocio: conNombre(clases.plataforma) },
  noSePuedeDeducir_losCompletanLosAgentes: clases.sinClasificarPorDominio.length,
  hostsMasFrecuentesSinClasificar: (() => { const m = new Map(); for (const r of clases.sinClasificarPorDominio) { const h = hostDe(fuentePrincipal(r.data)) || '(?)'; m.set(h, (m.get(h) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([host, n]) => ({ host, n })); })(),
  fuentesDeComprobacionEnFuentes: { aemet: rows.filter(r => fuentesDe(r.data).some(u => /aemet\.es/.test(u))).length, google: rows.filter(r => fuentesDe(r.data).some(u => /google\./.test(u))).length, primeraEsDeComprobacion: rows.filter(r => fuentesDe(r.data)[0] && esFuenteComprobacion(fuentesDe(r.data)[0])).length },
};
console.log(JSON.stringify(out, null, 1));
