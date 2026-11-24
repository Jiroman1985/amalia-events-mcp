// clave-sesion.mjs — clave canónica por sesión (municipio + fecha + hora + recinto). El título NO forma parte de la clave.
// Módulo puro: lo usan el alta atómica, la cola de revisión, el backfill y la auditoría nocturna.
import { hash } from './event-domain.mjs';
import { claveNombre, leg, horaDe, nombreParecido, terminosNombre } from './dedup_amalia.mjs';

// Solo se quitan artículos/preposiciones y prefijos vacíos de «casa/centro de cultura». El TIPO de recinto (teatro, auditorio, museo, iglesia, plaza, calle…) distingue lugares y NO se quita:
// «Teatro Principal» y «Auditorio Principal» son recintos distintos.
const GENERICAS = new Set(['de','del','la','las','el','los','y','e','en','casa','centro','cultura','cultural','municipal']);
// Alias de municipio (bilingües y oficiales). Cada grupo se reduce a su PRIMER elemento (forma normalizada: minúsculas, sin tildes ni signos).
// Aquí solo van pares seguros. NO se incluyen abreviaturas ambiguas («sanlucar» vale Sanlúcar de Barrameda y Sanlúcar la Mayor; «castellon», «hospitalet», «ciudadela»…).
// Se amplía desde la colección `municipio_alias` (alias «A/B» que traen eventos y negocios) o editando esta tabla.
const ALIAS_MUNICIPIO = [
  // Navarra
  ['altsasu','alsasua','altsasu alsasua'],['zizur mayor','zizur nagusia','zizur nagusia zizur mayor'],['estella','lizarra','estella lizarra'],['pamplona','iruna','pamplona iruna','iruna pamplona'],
  ['tudela','tutera'],['sanguesa','zangoza','sanguesa zangoza'],['baztan','baztan','valle de baztan'],['burguete','auritz','auritz burguete'],['roncesvalles','orreaga','orreaga roncesvalles'],
  ['luzaide','valcarlos','luzaide valcarlos'],['lumbier','irunberri','lumbier irunberri'],['olite','erriberri','olite erriberri'],['pueyo','puiu','pueyo puiu'],['ochagavia','otsagabia','otsagabia ochagavia'],
  ['roncal','erronkari','erronkari roncal'],['aibar','oibar','oibar aibar'],['aoiz','agoitz','agoitz aoiz'],['villava','atarrabia','atarrabia villava'],['burlada','burlata','burlata burlada'],
  ['huarte','uharte','uharte huarte'],['baranain','baranain','baranain barañain'],['ansoain','antsoain','antsoain ansoain'],['echarri aranaz','etxarri aranatz','etxarri aranatz echarri aranaz'],
  ['isaba','izaba','izaba isaba'],['lesaka','lesaka'],['elizondo','elizondo'],['irurtzun','irurtzun'],['berriozar','berriozar'],['noain','noain','noain valle de elorz','noain elortzibar'],
  // País Vasco
  ['donostia','san sebastian','donostia san sebastian','san sebastian donostia'],['vitoria','vitoria gasteiz','gasteiz','gasteiz vitoria'],['bilbao','bilbo','bilbo bilbao'],
  ['barakaldo','baracaldo'],['gernika','gernika lumo','guernica','guernica y luno','gernika lumo guernica y luno'],['irun','irun'],['hondarribia','fuenterrabia','hondarribia fuenterrabia'],
  ['errenteria','renteria','errenteria renteria'],['zarautz','zarauz','zarautz zarauz'],['arrasate','mondragon','arrasate mondragon'],['bergara','vergara','bergara vergara'],['onati','onate','onati onate'],
  ['laudio','llodio','laudio llodio'],['ayala','aiara','ayala aiara'],['agurain','salvatierra','agurain salvatierra'],['labastida','bastida','labastida bastida'],['laguardia','biasteri','laguardia biasteri'],
  ['lekeitio','lequeitio','lekeitio lequeitio'],['sopelana','sopela','sopela sopelana'],['plentzia','plencia','plentzia plencia'],['mungia','munguia','mungia munguia'],['ondarroa','ondarroa'],
  ['azpeitia','azpeitia'],['azkoitia','azcoitia','azkoitia azcoitia'],['tolosa','tolosa'],['eibar','eibar'],['elgoibar','elgoibar'],['durango','durango'],['leioa','leioa'],['portugalete','portugalete'],
  ['mundaka','mundaka'],['orduna','urduna','urduna orduna'],['zuia','zuya','zuya zuia'],['elburgo','burgelu','burgelu elburgo'],
  // Galicia
  ['a coruna','la coruna','coruna','a coruna la coruna'],['ourense','orense','ourense orense'],['santiago de compostela'],['a estrada','la estrada','a estrada la estrada'],['noia','noya','noia noya'],
  ['o barco de valdeorras','el barco de valdeorras','o barco','el barco de valdeorras o barco'],['xinzo de limia','ginzo de limia','xinzo de limia ginzo de limia'],['tui','tuy','tui tuy'],['a guarda','la guardia','a guarda la guardia'],
  ['baiona','bayona','baiona bayona'],['o grove','el grove','o grove el grove'],['sanxenxo','sangenjo','sanxenxo sangenjo'],['fisterra','finisterre','fisterra finisterre'],['muxia','muxia'],
  ['a pobra de trives','puebla de trives','a pobra de trives puebla de trives'],['vilagarcia de arousa','villagarcia de arosa','vilagarcia de arousa villagarcia de arosa'],['cangas do morrazo','cangas de morrazo'],
  ['o carballino','carballino','o carballino carballino'],['monforte de lemos'],['a pobra do caraminal','puebla del caraminal'],['viveiro','vivero','viveiro vivero'],['ribadeo','ribadeo'],
  ['mondonedo','mondonedo'],['ortigueira','ortigueira'],['cedeira','cedeira'],['betanzos','betanzos'],['carballo','carballo'],['ferrol','ferrol'],['lugo','lugo'],['pontevedra','pontevedra'],['vigo','vigo'],
  ['a rua','a rua de valdeorras','la rua','a rua la rua'],['o porrino','porrino','o porrino porrino'],['a laracha','la laracha'],['arteixo','arteijo','arteixo arteijo'],['cambre','cambre'],['oleiros','oleiros'],
  // Cataluña
  ['girona','gerona','girona gerona'],['lleida','lerida','lleida lerida'],['tarragona','tarragona'],['terrassa','tarrasa','terrassa tarrasa'],['l hospitalet de llobregat','el hospitalet de llobregat','hospitalet de llobregat'],
  ['sant cugat del valles','san cugat del valles','sant cugat','san cugat'],['vilanova i la geltru','villanueva y geltru','vilanova y la geltru'],['figueres','figueras','figueres figueras'],['banyoles','banolas','banyoles banolas'],
  ['vic','vich','vic vich'],['roses','rosas','roses rosas'],['sant feliu de guixols','san feliu de guixols','sant feliu de guixols san feliu de guixols'],['santa coloma de gramenet','santa coloma de gramanet'],
  ['cornella de llobregat','cornella','cornella de llobregat cornella'],['vilafranca del penedes','villafranca del penedes','vilafranca del penedes villafranca del penedes'],['la seu d urgell','seo de urgel','la seu d urgell seo de urgel'],
  ['vielha','viella','vielha e mijaran','viella e mijaran','vielha viella'],['lloret de mar','lloret de mar'],['tossa de mar','tossa de mar'],['cadaques','cadaques'],['sitges','sitges'],['cambrils','cambrils'],
  ['mollet del valles','mollet del valles'],['esplugues de llobregat','esplugues de llobregat'],['sant boi de llobregat','san baudilio de llobregat','sant boi de llobregat san baudilio de llobregat'],['el prat de llobregat','prat de llobregat'],
  ['la bisbal d emporda','la bisbal del ampurdan','la bisbal d emporda la bisbal del ampurdan'],['palamos','palamos'],['castelldefels','castelldefels'],['badalona','badalona'],['sabadell','sabadell'],['mataro','mataro'],
  ['granollers','granollers'],['manresa','manresa'],['olot','olot'],['reus','reus'],['tortosa','tortosa'],['el vendrell','vendrell'],['igualada','igualada'],['berga','berga'],['solsona','solsona'],['balaguer','balaguer'],
  ['puigcerda','puigcerda'],['tarrega','tarrega'],['cervera','cervera'],['montblanc','montblanch','montblanc montblanch'],['valls','valls'],['falset','falset'],['gandesa','gandesa'],['tremp','tremp'],['blanes','blanes'],['calella','calella'],
  ['rubi','rubi'],['salou','salou'],['mora d ebre','mora de ebro','mora d ebre mora de ebro'],['sant joan despi','san juan despi'],['sant andreu de la barca','san andres de la barca'],['la garriga','garriga'],
  // Comunitat Valenciana
  ['alicante','alacant','alacant alicante','alicante alacant'],['elche','elx','elx elche','elche elx'],['castellon de la plana','castello de la plana','castello de la plana castellon de la plana'],['valencia','valencia'],
  ['orihuela','oriola','orihuela oriola','oriola orihuela'],['alcoy','alcoi','alcoi alcoy','alcoy alcoi'],['denia','denia'],['javea','xabia','xabia javea','javea xabia'],['calpe','calp','calp calpe','calpe calp'],
  ['gandia','gandia'],['sagunto','sagunt','sagunt sagunto','sagunto sagunt'],['jativa','xativa','xativa jativa','jativa xativa'],['vinaroz','vinaros','vinaros vinaroz','vinaroz vinaros'],['benicarlo','benicarlo'],
  ['peniscola','peniscola','peniscola peniscola'],['vila real','vila real villarreal','villarreal vila real'],['burriana','borriana','borriana burriana','burriana borriana'],['segorbe','segorbe'],['morella','morella'],
  ['alcora','l alcora','l alcora alcora','alcora l alcora'],['la vall d uixo','vall de uxo','la vall d uixo vall de uxo'],['petrer','petrel','petrer petrel','petrel petrer'],['crevillent','crevillente','crevillent crevillente'],
  ['ontinyent','onteniente','ontinyent onteniente','onteniente ontinyent'],['xixona','jijona','xixona jijona','jijona xixona'],['alboraya','alboraia','alboraia alboraya','alboraya alboraia'],['burjassot','burjasot','burjassot burjasot'],
  ['xirivella','chirivella','xirivella chirivella'],['sant joan d alacant','san juan de alicante','sant joan d alacant san juan de alicante'],['el campello','campello'],['l alfas del pi','alfaz del pi','l alfas del pi alfaz del pi'],
  ['la nucia','nucia'],['benidorm','benidorm'],['torrevieja','torrevieja'],['torrent','torrent'],['paterna','paterna'],['alzira','alcira','alzira alcira'],['sueca','sueca'],['cullera','cullera'],['onda','onda'],['villena','villena'],
  ['elda','elda'],['ibi','ibi'],['santa pola','santa pola'],['guardamar del segura','guardamar del segura'],['pego','pego'],['oliva','oliva'],['requena','requena'],['utiel','utiel'],['manises','manises'],['mislata','mislata'],
  ['banyeres de mariola','bañeres de mariola','banyeres de mariola baneres de mariola'],['l eliana','eliana','l eliana la eliana'],['la pobla de vallbona','pobla de vallbona'],['altea','altea'],['la vila joiosa','villajoyosa','la vila joiosa villajoyosa'],
  // Baleares
  ['palma de mallorca','palma de mallorca palma'],['mao','mahon','mao mahon','mahon mao'],['ciutadella de menorca','ciudadela de menorca','ciutadella de menorca ciudadela de menorca'],['eivissa','ibiza','eivissa ibiza','ibiza eivissa'],
  ['sant antoni de portmany','san antonio de portmany','sant antoni de portmany san antonio de portmany'],['santa eularia des riu','santa eulalia del rio','santa eularia des riu santa eulalia del rio'],
  ['sant josep de sa talaia','sant josep de sa talaia san jose'],['alcudia','alcudia','alcudia alcudia'],['pollenca','pollensa','pollenca pollensa','pollensa pollenca'],['soller','soller'],['inca','inca'],['manacor','manacor'],
  ['llucmajor','llucmajor'],['felanitx','felanitx'],['santanyi','santanyi','santanyi santanyi'],['capdepera','capdepera'],['sant llorenc des cardassar','san lorenzo del cardesar','sant llorenc des cardassar san lorenzo del cardesar'],
  ['son servera','son servera'],['arta','arta'],['andratx','andraitx','andratx andraitx'],['calvia','calvia'],['marratxi','marratxi'],['campos','campos'],['sa pobla','sa pobla la puebla'],['muro','muro'],
  ['santa margalida','santa margarita','santa margalida santa margarita'],['es castell','villacarlos','es castell villacarlos'],['es mercadal','mercadal','es mercadal el mercadal'],['ferreries','ferrerias','ferreries ferrerias'],
  ['es migjorn gran','mitjorn gran','es migjorn gran migjorn gran'],['sant lluis','sant lluis san luis'],['formentera','formentera']
];
const MAPA_ALIAS = new Map(); for (const g of ALIAS_MUNICIPIO) for (const a of g) if (!MAPA_ALIAS.has(a)) MAPA_ALIAS.set(a, g[0]);
// Alias aprendidos (colección `municipio_alias`, cargados por el servicio). Nunca pisan la tabla fija.
let ALIAS_DINAMICO = new Map();
export function setAliasDinamico(grupos) {
  const m = new Map();
  for (const g of grupos || []) { const partes = (g.partes || []).map(p => claveNombre(p)).filter(Boolean); if (partes.length < 2) continue; const canon = MAPA_ALIAS.get(partes.find(p => MAPA_ALIAS.has(p))) || partes[0]; for (const p of partes) if (!MAPA_ALIAS.has(p) && !m.has(p)) m.set(p, canon); }
  ALIAS_DINAMICO = m;
}
const aliasDe = p => MAPA_ALIAS.get(p) ?? ALIAS_DINAMICO.get(p);
/** Municipio canónico: normaliza, parte «Lumbier/Irunberri» o «Ayala / Aiara» en sus nombres y los reduce a su grupo de alias. */
export function municipioClave(city) {
  const full = claveNombre(String(city || '').replace(/[\/|]/g, ' | '));
  if (!full) return '';
  const partes = String(city || '').split(/\s*[\/|]\s*/).map(x => claveNombre(x)).filter(Boolean);
  if (aliasDe(claveNombre(city))) return aliasDe(claveNombre(city));
  for (const p of partes) if (aliasDe(p)) return aliasDe(p);
  return partes[0] || full;
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Recinto normalizado: minúsculas, sin tildes/signos, sin artículos ni genéricos SOLO si queda algún término; vacío si es el propio municipio. */
export function recintoClave(lugar, city) {
  const full = claveNombre(lugar);
  if (!full || full === claveNombre(city) || full === municipioClave(city)) return '';
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
export const ciudadDe = d => leg(d, 'city', 'ciudad') || (typeof d.ubicacion === 'string' ? d.ubicacion : d.ubicacion?.municipio);
const lugarDe = d => leg(d, 'lugar', 'recinto', 'venue') || (d.ubicacion && typeof d.ubicacion === 'object' ? d.ubicacion.lugar : null);

/** Clave de UNA sesión. null si falta municipio o fecha ISO (no se inventa nada). */
export function claveSesion({ city, lugar, fechaLocal, horaLocal, discriminador = '' }) {
  const municipio = municipioClave(city);
  if (!municipio || !ISO.test(String(fechaLocal || ''))) return null;
  const hora = HORA.test(String(horaLocal || '')) ? horaLocal : null;
  const recinto = recintoClave(lugar, city);
  const fuerza = hora && recinto ? 'fuerte' : (hora || recinto ? 'media' : 'debil');
  const clave = [municipio, fechaLocal, hora || 'sin_hora', recinto].join('|') + (discriminador ? '|#' + claveNombre(discriminador) : '');
  return { municipio, fecha: fechaLocal, hora, recinto, discriminador: discriminador || '', fuerza, clave, municipioFecha: municipio + '|' + fechaLocal };
}
/** Fecha local de Madrid de un instante: con offset/Z se convierte; sin offset («2026-12-04 11:00») ya es hora local. */
export function fechaHoraMadrid(dateTime, tz = 'Europe/Madrid') {
  if (typeof dateTime !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(dateTime)) return { fecha: null, hora: null };
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(dateTime)) return { fecha: dateTime.slice(0, 10), hora: /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2})/.test(dateTime) ? dateTime.slice(11, 16) : null };
  const t = new Date(dateTime); if (!Number.isFinite(t.getTime())) return { fecha: dateTime.slice(0, 10), hora: null };
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { fecha: `${f.year}-${f.month}-${f.day}`, hora: `${f.hour}:${f.minute}` };
}
const MAX_DIAS_RANGO = 31;
const sumaDias = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/** Temporada: rango fechaLocal–fechaFinLocal de más de 31 días sin sesiones explícitas (exposición, programa largo). No genera claves por día: una única marca de temporada que la auditoría compara con cualquier sesión del mismo recinto y municipio dentro del rango. */
export function temporadaDeEvento(d) {
  if (Array.isArray(d.sesiones) && d.sesiones.length) return null;
  const dt = fechaHoraMadrid(d.dateTime, d.timeZone || 'Europe/Madrid'), f = leg(d, 'fechaLocal', 'fecha_inicio') || dt.fecha, fin = d.fechaFinLocal;
  if (!f || !ISO.test(f) || !ISO.test(String(fin || '')) || fin <= f) return null;
  return Math.round((Date.parse(fin) - Date.parse(f)) / 864e5) > MAX_DIAS_RANGO ? { inicio: f, fin } : null;
}
/** Sesiones de un evento: sesiones[] si existen; si no, UNA por día entre fechaLocal y fechaFinLocal (hasta 31 días; un rango mayor es una exposición/temporada y solo cuenta el primer día). */
export function sesionesDeEvento(d) {
  const dt = fechaHoraMadrid(d.dateTime, d.timeZone || 'Europe/Madrid');
  const f = leg(d, 'fechaLocal', 'fecha_inicio') || dt.fecha;
  const hora = d.horaLocal || d.hora || dt.hora || null;
  const lista = Array.isArray(d.sesiones) && d.sesiones.length ? d.sesiones.map(s => ({ fechaLocal: s.fechaLocal, horaLocal: s.horaLocal || null })) : [];
  if (f && !lista.some(s => s.fechaLocal === f)) lista.unshift({ fechaLocal: f, horaLocal: hora });
  if (!(Array.isArray(d.sesiones) && d.sesiones.length) && f && ISO.test(f) && ISO.test(String(d.fechaFinLocal || '')) && d.fechaFinLocal > f) {
    const dias = Math.round((Date.parse(d.fechaFinLocal) - Date.parse(f)) / 864e5);
    // Ficha con PERIODO (del f al fin, sin sesiones explícitas): sus días se marcan para que no bloqueen las sesiones sueltas (van a la cola).
    if (dias <= MAX_DIAS_RANGO) { for (let i = 1; i <= dias; i++) lista.push({ fechaLocal: sumaDias(f, i), horaLocal: hora }); for (const s of lista) s.periodo = true; }
  }
  return lista;
}
/**
 * Documentos de `sesiones_clave` de un evento. ID: hash de la clave si es FUERTE (único en todo el catálogo);
 * si no, el ID incluye el eventId (nunca colisiona, pero sirve de índice por municipioFecha).
 */
export function clavesDeEvento(eventId, d, { discriminador = '' } = {}) {
  const out = [], temp = temporadaDeEvento(d);
  if (temp) {
    const municipio = municipioClave(ciudadDe(d)); if (!municipio) return out;
    const recinto = recintoClave(lugarDe(d), ciudadDe(d)), clave = ['temporada', municipio, recinto, temp.inicio, temp.fin].join('|');
    out.push({ id: 'sk_' + hash('temporada\0' + eventId + clave).slice(0, 40), fuerte: false, temporada: true, data: { eventId, negocioId: d.negocioId || null, clave, fuerza: 'temporada', municipio, fecha: temp.inicio, fechaFin: temp.fin, hora: null, recinto, municipioFecha: municipio + '|temporada', estado: 'activa', prueba: d.prueba === true, titulo: claveNombre(leg(d, 'titulo', 'nombre')), tituloOriginal: leg(d, 'titulo', 'nombre') || null, urlNorm: d.fuentes?.[0]?.url ? normalizarUrl(d.fuentes[0].url) : null, discriminador: '', at: new Date().toISOString() } });
    return out;
  }
  for (const s of sesionesDeEvento(d)) {
    const k = claveSesion({ city: ciudadDe(d), lugar: lugarDe(d), fechaLocal: s.fechaLocal, horaLocal: s.horaLocal, discriminador: discriminador || d.discriminadorSesion || '' });
    if (!k) continue;
    const fuerte = k.fuerza === 'fuerte';
    const id = 'sk_' + hash(k.clave + (fuerte ? '' : '\0' + eventId)).slice(0, 40);
    if (out.some(o => o.id === id)) continue;
    out.push({ id, fuerte, data: { eventId, negocioId: d.negocioId || null, clave: k.clave, fuerza: k.fuerza, municipio: k.municipio, fecha: k.fecha, hora: k.hora, recinto: k.recinto, municipioFecha: k.municipioFecha, estado: 'activa', ...(s.periodo ? { periodo: true, periodoFin: d.fechaFinLocal } : {}), prueba: d.prueba === true, titulo: claveNombre(leg(d, 'titulo', 'nombre')), tituloOriginal: leg(d, 'titulo', 'nombre') || null, urlNorm: d.fuentes?.[0]?.url ? normalizarUrl(d.fuentes[0].url) : null, discriminador: k.discriminador, at: new Date().toISOString() } });
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
  // Una ficha con periodo frente a una sesión suelta (o al revés) nunca bloquea: va a la cola. Dos fichas con periodo, o dos sesiones sueltas, siguen las reglas normales.
  const mixtos = new Set(vecinos.filter(v => v && (!!cand.periodo !== !!v.periodo)).map(v => v.eventId));
  for (const m of motivos) if (m.decision === 'bloquea' && mixtos.has(m.eventId)) { m.decision = 'cola'; m.motivo = 'sesion_suelta_y_ficha_con_periodo'; }
  const decision = motivos.some(m => m.decision === 'bloquea') ? 'bloquea' : motivos.length ? 'cola' : 'libre';
  return { decision, motivos };
}
