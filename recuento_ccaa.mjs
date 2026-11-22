// recuento_ccaa.mjs — SOLO LECTURA. Eventos publicados fuera de Fever por comunidad autónoma.
import { FirestoreStore } from './firestore-store.mjs';
import { normalizeText } from './event-domain.mjs';
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const rows = []; let cursor = null;
for (;;) { const page = await store.list('eventos', { cursor, limit: 500 }); rows.push(...page); if (page.length < 500) break; cursor = page.at(-1).id; }
const CC = {
 'Andalucía': 'almeria cadiz cordoba granada huelva jaen malaga sevilla',
 'Aragón': 'huesca teruel zaragoza', 'Asturias': 'asturias', 'Illes Balears': 'illes balears baleares islas baleares mallorca menorca ibiza',
 'Canarias': 'las palmas santa cruz de tenerife tenerife gran canaria canarias', 'Cantabria': 'cantabria',
 'Castilla y León': 'avila burgos leon palencia salamanca segovia soria valladolid zamora',
 'Castilla-La Mancha': 'albacete ciudad real cuenca guadalajara toledo', 'Cataluña': 'barcelona girona gerona lleida lerida tarragona',
 'C. Valenciana': 'alicante alacant castellon castello valencia', 'Extremadura': 'badajoz caceres', 'Galicia': 'a coruna la coruna lugo ourense orense pontevedra',
 'Madrid': 'madrid comunidad de madrid', 'Murcia': 'murcia region de murcia', 'Navarra': 'navarra', 'País Vasco': 'alava araba gipuzkoa guipuzcoa bizkaia vizcaya',
 'La Rioja': 'la rioja rioja', 'Ceuta': 'ceuta', 'Melilla': 'melilla' };
const PROV = new Map(); // más largas primero se resuelven por coincidencia exacta
for (const [c, l] of Object.entries(CC)) { const items = l === 'las palmas santa cruz de tenerife tenerife gran canaria canarias' ? ['las palmas','santa cruz de tenerife','tenerife','gran canaria','canarias'] : l === 'illes balears baleares islas baleares mallorca menorca ibiza' ? ['illes balears','baleares','islas baleares','mallorca','menorca','ibiza'] : l === 'ciudad real' ? [l] : l.split(' ').length > 1 && /^(a coruna|la coruna|ciudad real|region de murcia|comunidad de madrid|la rioja)/.test(l) ? [] : []; }
const LISTA = { 'Andalucía':['almeria','cadiz','cordoba','granada','huelva','jaen','malaga','sevilla','andalucia'], 'Aragón':['huesca','teruel','zaragoza','aragon'], 'Asturias':['asturias','principado de asturias'], 'Illes Balears':['illes balears','baleares','islas baleares','mallorca','menorca','ibiza','balears'], 'Canarias':['las palmas','santa cruz de tenerife','tenerife','gran canaria','canarias'], 'Cantabria':['cantabria'], 'Castilla y León':['avila','burgos','leon','palencia','salamanca','segovia','soria','valladolid','zamora','castilla y leon'], 'Castilla-La Mancha':['albacete','ciudad real','cuenca','guadalajara','toledo','castilla la mancha','castilla-la mancha'], 'Cataluña':['barcelona','girona','gerona','lleida','lerida','tarragona','cataluna','catalunya'], 'C. Valenciana':['alicante','alacant','castellon','castello','valencia','comunidad valenciana','comunitat valenciana'], 'Extremadura':['badajoz','caceres','extremadura'], 'Galicia':['a coruna','la coruna','lugo','ourense','orense','pontevedra','galicia'], 'Madrid':['madrid','comunidad de madrid'], 'Murcia':['murcia','region de murcia'], 'Navarra':['navarra','nafarroa'], 'País Vasco':['alava','araba','gipuzkoa','guipuzcoa','bizkaia','vizcaya','pais vasco','euskadi'], 'La Rioja':['la rioja','rioja'], 'Ceuta':['ceuta'], 'Melilla':['melilla'] };
const MAP = new Map(); for (const [c, l] of Object.entries(LISTA)) for (const p of l) MAP.set(p, c);
const SEMILLA = {'bilbao':'País Vasco','donostia san sebastian':'País Vasco','san sebastian':'País Vasco','vitoria gasteiz':'País Vasco','las palmas de gran canaria':'Canarias','oviedo':'Asturias','gijon':'Asturias','aviles':'Asturias','alcala de henares':'Madrid','san lorenzo de el escorial':'Madrid','sabadell':'Cataluña','terrassa':'Cataluña','santiago de compostela':'Galicia','vigo':'Galicia','pamplona':'Navarra','alora':'Andalucía','benalmadena':'Andalucía','ronda':'Andalucía','marbella':'Andalucía','logrono':'La Rioja'}; for (const [k,v] of Object.entries(SEMILLA)) MAP.set(k,v);
const OCULTO = /cancel|retirad|pend|rechaz|borr|oculto/i;
const publicado = d => d.retirado !== true && d.activa !== false && d.prueba !== true && !OCULTO.test(String(d.estado || ''));
const host = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const esFeverSource = d => /^fever/i.test(String(d.source || ''));
const esFeverViejo = d => [...(d.fuentes || []).map(s => s?.url), d.link, d.enlace_original].some(u => /(^|\.)fever(up)?\.com$/.test(host(u || ''))) || /fever/i.test(String(d.origen?.proveedor || '')) || /fever/i.test(String(d.fuente_nombre || ''));
const esFever = d => esFeverSource(d);
const ccaaDe = d => { for (const v of [d.provincia, d.geoUbicacion?.provincia, d.city, d.ciudad, d.geoUbicacion?.municipio]) { const n = normalizeText(v || ''); if (MAP.has(n)) return MAP.get(n); } return null; };
const aprendida = new Map(); for (const r of rows) { const d = r.data; const c = [d.provincia, d.geoUbicacion?.provincia].map(v => MAP.get(normalizeText(v || ''))).find(Boolean); const n = normalizeText(d.city || d.ciudad || ''); if (c && n && !aprendida.has(n)) aprendida.set(n, c); }
const srcDist = {}; for (const r of rows) { const k = String(r.data.source ?? '(vacío)'); srcDist[k] = (srcDist[k] || 0) + 1; }
const provAprendida = new Map(); for (const r of rows) { const d = r.data; const p = [d.provincia, d.geoUbicacion?.provincia].find(v => v && MAP.has(normalizeText(v))); const n = normalizeText(d.city || d.ciudad || ''); if (p && n && !provAprendida.has(n)) provAprendida.set(n, p); }
const provDe = d => { const p = [d.provincia, d.geoUbicacion?.provincia].find(v => v && MAP.has(normalizeText(v))); return p || provAprendida.get(normalizeText(d.city || d.ciudad || '')) || null; };
const hoy = new Date().toISOString().slice(0, 10), fecha = d => d.fechaLocal || d.fecha_inicio || (d.dateTime ? String(d.dateTime).slice(0, 10) : null);
const porProv = {}; const tot = {}, sinCcaa = {}; const res = { documentos: rows.length, publicados: 0, fever: 0, fueraDeFever: 0, fueraFeverVigentes: 0 };
for (const r of rows) { const d = r.data; if (!publicado(d)) continue; res.publicados++; if (esFever(d)) { res.fever++; continue; } res.fueraDeFever++; const vig = !fecha(d) || fecha(d) >= hoy; if (vig) res.fueraFeverVigentes++; const c = ccaaDe(d) || aprendida.get(normalizeText(d.city || d.ciudad || '')) || 'SIN CLASIFICAR'; if (vig) { const pv = provDe(d); const pk = pv ? normalizeText(pv) : '(sin provincia)'; const q = (porProv[pk] ||= { n: 0, vig: 0, nombre: pv || '(sin provincia)', ccaa: c }); q.vig++; }
 const t = tot[c] ||= { total: 0, vigentes: 0, ciudades: {} }; t.total++; if (vig) t.vigentes++; if (c === 'SIN CLASIFICAR') { const k = d.city || d.ciudad || '(sin ciudad)'; sinCcaa[k] = (sinCcaa[k] || 0) + 1; } }
res.porComunidad = Object.entries(tot).map(([c, t]) => ({ comunidad: c, total: t.total, vigentes: t.vigentes })).sort((a, b) => b.total - a.total);
res.sinClasificarTopCiudades = Object.entries(sinCcaa).sort((a, b) => b[1] - a[1]).slice(0, 15);
res.distribucionSource = Object.entries(srcDist).sort((a,b)=>b[1]-a[1]).slice(0,15);
res.provinciasVigentes = Object.values(porProv).map(q => ({ provincia: q.nombre, comunidad: q.ccaa, vigentes: q.vig })).sort((a,b)=>b.vigentes-a.vigentes);
console.log(JSON.stringify(res, null, 1));
