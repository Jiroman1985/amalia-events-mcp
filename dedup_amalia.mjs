// dedup_amalia.mjs — Algoritmo de deduplicación del catálogo `eventos`, EXTRAÍDO VERBATIM del MCP
// amalia-events (event-service.mjs findDuplicates + event-domain.mjs). Módulo puro, sin dependencias
// del MCP: lo reutilizan los writers externos (sync_malagatech, backfill, alta web) para ejecutar el
// MISMO criterio de dedup que la admisión del MCP. NO inventar similitudes ni umbrales propios: si un
// caso no está cubierto por estos predicados, NO es conflicto automático; se informa para revisión.
//
// CONTRATO DE UNIVERSO (obligatorio): `docs` debe ser la colección `eventos` COMPLETA, leída
// paginando HASTA AGOTAR (pageSize<=500, cursor por id, sin asumir nunca que "caben en una página"),
// y `reservas` TODA la colección amalia_event_reservations. Si el writer no puede leer el universo
// completo (error, timeout, permiso), debe ABORTAR la escritura e informar (fail-closed): un array
// parcial o "corto" NO prueba ausencia de duplicados. exhaustivo=true solo certifica que se
// escaneó todo lo entregado; la completitud de lo entregado es responsabilidad del llamador.
//
// Uso: escanearDuplicados(candidato, docs, {limite=5000, reservas=[]})
//   candidato: {negocioId, titulo, city, fechaLocal, horaLocal?, sesionId?, fuentes:[{url,sourceId?}], origen?{proveedor,id_externo,id_sesion}}
//   docs: array de docs Firestore ya decodificados (forma canónica MCP o legacy: nombre/ciudad/fecha_inicio/enlace_original/ubicacion)
//   reservas: docs de amalia_event_reservations (opcional; aportan motivo reserva_origen_exacta)
// Devuelve: {coincidencias:[{eventId, motivos, confianza}], escaneados, exhaustivo}
//   exhaustivo=false => FAIL-CLOSED: detener la creación e informar (hay registros sin revisar).
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const normalizeText = v => String(v||'').normalize('NFKD').replace(/\p{M}/gu,'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
export const leg = (d,k,...alt) => { for (const key of [k,...alt]) { if (d[key]!=null) return d[key]; } return null; };
export const originKey = o => 'res_'+hash([o.proveedor,o.id_externo,o.id_sesion].join('\0')).slice(0,40);
export function eventIdentity(e) { return 'ev_'+hash([e.negocioId,e.fuentes[0].sourceId || e.fuentes[0].url,e.sesionId,e.sesionExplicita?'':e.fechaLocal,e.sesionExplicita?'':e.horaLocal || '',e.sesionExplicita?'':e.titulo.normalize('NFKC').toLowerCase()].join('\0')).slice(0,32); }

const EXACTAS = new Set(['reserva_origen_exacta','identidad_calculada','url_fuente','source_id','misma_sesion','titulo_fecha_lugar']);
// Motivos que solo dicen «misma página/ID de fuente, otra sesión». Por sí solos son informativos si el candidato
// acredita fecha, hora, lugar y título propios y distintos de los del registro coincidente (ver `informativaPorFuente`).
const SOLO_FUENTE = new Set(['url_fuente_otra_sesion','source_id_otra_sesion']);
/** Hora local de un registro: canónico (horaLocal), legacy (hora) o dateTime con desfase explícito (la web). Un instante UTC ('Z') no sirve: devuelve null. */
export const horaDe = d => d.horaLocal||d.hora||(typeof d.dateTime==='string'&&/[+-]\d\d:\d\d$/.test(d.dateTime)?d.dateTime.slice(11,16):null)||null;
/**
 * ¿Es la coincidencia solo «misma página de fuente» entre unidades realmente distintas? Función única para el MCP y la web.
 * El candidato debe acreditar por sí mismo fecha, hora, título y lugar o ciudad; el registro, fecha y hora; y deben
 * diferir en fecha u hora y en título. Mismo título (o uno contenido en el otro) = posible sesión reprogramada o
 * recurrente: no se decide aquí, va a revisión. Cualquier otro motivo en la coincidencia la mantiene bloqueante.
 */
export function informativaPorFuente(candidato, row, motivos) {
 if(!motivos.length||!motivos.every(m=>SOLO_FUENTE.has(m)))return false;
 const fecha=candidato.fechaLocal||null,hora=candidato.horaLocal||null,title=candidato.titulo?normalizeText(candidato.titulo):null;
 if(!(fecha&&title&&(candidato.lugar||candidato.city)))return false;
 const d=row.data||row;
 const dFecha=leg(d,'fechaLocal','fecha_inicio')||d.dateTime?.slice(0,10)||null,dHora=horaDe(d),dTitulo=normalizeText(leg(d,'titulo','nombre'));
 // Páginas de agenda (un ayuntamiento publica una URL con muchas citas): título propio y distinto + otra fecha basta, sin exigir hora ni municipio distinto.
 if(!(dFecha&&dTitulo&&dTitulo!==title&&!dTitulo.includes(title)&&!title.includes(dTitulo)))return false;
 if(dFecha!==fecha)return true;
 return !!(hora&&dHora&&dHora!==hora);
}

// Una sesión derivada de fecha/hora no es un identificador de evento global.
// Si faltan título o municipio, o ambos títulos/municipios no difieren claramente, se mantiene revisión.
export function horarioImplicitoDistinto(candidato, row, motivos) {
 if(!motivos.length||!motivos.every(m=>m==='sesion_horario_otra_actividad'))return false;
 const d=row.data||row, cCity=normalizeText(candidato.city), dCity=normalizeText(leg(d,'city','ciudad')||(typeof d.ubicacion==='string'?d.ubicacion:d.ubicacion?.municipio));
 const ct=normalizeText(candidato.titulo),dt=normalizeText(leg(d,'titulo','nombre'));
 const sesion=candidato.sesionId||'',stored=d.sesionId||'';
 const isDerived=(value,explicit)=>explicit!==true&&/^\d{4}-\d{2}-\d{2}\/(?:\d{2}:\d{2}|sin-hora)$/.test(value);
 return !!(isDerived(sesion,candidato.sesionExplicita)&&isDerived(stored,d.sesionExplicita)&&sesion===stored&&cCity&&dCity&&cCity!==dCity&&ct&&dt&&ct!==dt&&!ct.includes(dt)&&!dt.includes(ct));
}
/**
 * Mismo sesionId (derivado o explícito) u horario implícito en MUNICIPIOS DISTINTOS es solo un aviso: un identificador de fecha/hora no es
 * global y dos pueblos pueden coincidir en día y hora. Solo aplica si todos los motivos son de sesión y ambos municipios constan y difieren;
 * cualquier señal exacta (URL, sourceId, misma sesión y título, título+fecha+lugar) sigue bloqueando.
 */
export function municipioDistintoAviso(candidato, row, motivos) {
 if(!motivos.length||!motivos.every(m=>m==='sesion_coincidente'||m==='sesion_horario_otra_actividad'))return false;
 const d=row.data||row,cCity=normalizeText(candidato.city),dCity=normalizeText(leg(d,'city','ciudad')||(typeof d.ubicacion==='string'?d.ubicacion:d.ubicacion?.municipio));
 const ct=normalizeText(candidato.titulo),dt=normalizeText(leg(d,'titulo','nombre'));
 // Da igual que el sesionId sea derivado o lo haya puesto el agente: un identificador de fecha/hora igual en municipios distintos no identifica el mismo evento.
 return !!(cCity&&dCity&&cCity!==dCity&&ct&&dt);
}
// --- Regla de duplicado (2.18.0): un evento solo es duplicado si coinciden las cuatro cosas ---
/** Clave de nombre/lugar: minúsculas, sin tildes ni signos de puntuación, espacios recortados y colapsados. */
export const claveNombre=v=>String(v||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
const levenshtein=(a,b)=>{if(a===b)return 0;let prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const cur=[i];for(let j=1;j<=b.length;j++)cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur;}return prev[b.length];};
/** Nombres no idénticos pero muy parecidos (p. ej. «Concierto de Santa Cecilia» / «Concerto de Santa Cecilia»). */
export const nombreParecido=(a,b)=>{if(!a||!b||a===b)return false;const min=Math.min(a.length,b.length),max=Math.max(a.length,b.length);if(min<8)return false;if(min>=12&&(a.includes(b)||b.includes(a)))return true;return 1-levenshtein(a,b)/max>=0.85;};
// Términos significativos de un nombre: sin artículos ni preposiciones, sin plural y recortados a la raíz (5 letras): «Taller de corona navideña» y «Taller Corona de Navidad» comparten {talle, coron, navid}.
const STOP_NOMBRE=new Set(['de','del','la','las','el','los','y','e','en','para','con','un','una','al','a','por','y']);
export const terminosNombre=v=>new Set(claveNombre(v).split(' ').filter(t=>t&&!STOP_NOMBRE.has(t)).map(t=>(t.length>4&&t.endsWith('s')?t.slice(0,-1):t).slice(0,5)));
const mismosTerminos=(a,b)=>a.size>=2&&a.size===b.size&&[...a].every(t=>b.has(t));
const solapeAlto=(a,b)=>{const inter=[...a].filter(t=>b.has(t)).length;return inter>=2&&inter/Math.min(a.size,b.size)>=0.8;};
const ciudadDe=d=>claveNombre(leg(d,'city','ciudad')||(typeof d.ubicacion==='string'?d.ubicacion:d.ubicacion?.municipio));
const lugarDe=d=>claveNombre(leg(d,'lugar','recinto','venue')||(d.ubicacion&&typeof d.ubicacion==='object'?d.ubicacion.lugar:null));
/**
 * 'duplicado' si coinciden (a) nombre normalizado, (b) fecha, (c) lugar (recinto y municipio) y (d) hora (o falta en alguno de los dos).
 * 'parecido' si (b), (c), (d) coinciden y el nombre no es idéntico pero sí muy parecido. null en cualquier otro caso.
 * Un recinto vacío, o igual al municipio, cuenta como «sin recinto»: no distingue lugares.
 */
export function reglaDuplicado(candidato,row){
 const d=row.data||row,t=claveNombre(candidato.titulo),dt=claveNombre(leg(d,'titulo','nombre'));
 const fecha=candidato.fechaLocal||null,dF=leg(d,'fechaLocal','fecha_inicio')||d.dateTime?.slice(0,10)||null;
 if(!t||!dt||!fecha||!dF||fecha!==dF)return null;
 const city=claveNombre(candidato.city),dc=ciudadDe(d);if(!city||!dc||city!==dc)return null;
 const venue=x=>x&&x!==city?x:'',l=venue(claveNombre(candidato.lugar)),dl=venue(lugarDe(d));if(l&&dl&&l!==dl)return null;
 const h=candidato.horaLocal||null,dh=horaDe(d);if(h&&dh&&h!==dh)return null;
 if(t===dt)return 'duplicado';
 // Mismas palabras con otro orden, flexión o artículos («Taller de corona navideña» / «Taller Corona de Navidad») en el mismo día, lugar y hora: es la misma sesión.
 const ta=terminosNombre(candidato.titulo),tb=terminosNombre(leg(d,'titulo','nombre'));
 if(mismosTerminos(ta,tb))return 'duplicado';
 return nombreParecido(t,dt)||solapeAlto(ta,tb)?'parecido':null;
}
/** Única clasificación de coincidencias (admisión y buscar_duplicados_global): solo bloquean la regla de las cuatro coincidencias, la reserva de origen y la identidad calculada (mismo documento). Todo lo demás es informativo. */
export function clasificarCoincidencias(entries,identity=r=>({eventId:r.eventId||r.id})){
 const coincidencias=[],informativas=[];
 for(const {row,motivos} of entries){
  const tecnico=motivos.some(m=>m==='reserva_origen_exacta'||m==='identidad_calculada'),duplicado=motivos.includes('duplicado_sesion');
  const item={...identity(row),motivos};
  if(tecnico||duplicado)coincidencias.push({...item,confianza:'exacta'});
  else informativas.push({...item,confianza:motivos.includes('posible_duplicado')?'posible_duplicado':'informativa'});
 }
 return {coincidencias,informativas};
}
export function motivoSesion(candidato,row) {
 const d=row.data||row;if(!candidato.sesionId||d.sesionId!==candidato.sesionId)return null;
 if(horarioImplicitoDistinto(candidato,row,['sesion_horario_otra_actividad']))return 'sesion_horario_otra_actividad';
 const title=normalizeText(candidato.titulo),dTitulo=normalizeText(leg(d,'titulo','nombre'));
 const dFecha=leg(d,'fechaLocal','fecha_inicio')||d.dateTime?.slice(0,10)||null;
 return !title?'sesion_coincidente':dTitulo===title?(candidato.fechaLocal&&dFecha&&dFecha!==candidato.fechaLocal?'sesion_conflicto_fecha':'misma_sesion'):'sesion_coincidente';
}
/** IDs de evento que produciría este candidato (forma legacy y canónica): permiten comprobar «identidad_calculada» con lecturas puntuales, sin recorrer el catálogo. */
export function identidadesCalculadas(candidato) {
 const urls=(candidato.fuentes||[]).map(s=>String(s.url)).filter(Boolean),sourceIds=(candidato.fuentes||[]).map(s=>s.sourceId).filter(Boolean).map(String);
 const title=candidato.titulo?normalizeText(candidato.titulo):null,fecha=candidato.fechaLocal||null,sesion=candidato.sesionId||null;
 if(!(candidato.negocioId&&(urls.length||sourceIds.length)&&(sesion||(fecha&&title))))return [];
 const common={negocioId:candidato.negocioId,fuentes:[{url:urls[0]||'https://invalid.local/',sourceId:sourceIds[0]||null}],fechaLocal:fecha||'',titulo:candidato.titulo||''};
 const candidates=[{...common,sesionId:sesion||`${fecha}/`,sesionExplicita:!!sesion,horaLocal:null},{...common,sesionId:sesion||`${fecha}/sin-hora`,sesionExplicita:candidato.sesionExplicita ?? !!sesion,horaLocal:candidato.horaLocal||null}];
 return [...new Set(candidates.map(eventIdentity))];
}
export function escanearDuplicados(candidato, docs, {limite=5000, reservas=[]}={}) {
 const urls=(candidato.fuentes||[]).map(s=>String(s.url)).filter(Boolean);
 const sourceIds=(candidato.fuentes||[]).map(s=>s.sourceId).filter(Boolean).map(String);
 const title=candidato.titulo?normalizeText(candidato.titulo):null, city=candidato.city?normalizeText(candidato.city):null;
 const fecha=candidato.fechaLocal||null, sesion=candidato.sesionId||null;
 const found=new Map();
 const add=(r,motivo)=>{const cur=found.get(r.eventId||r.id)||{row:r,motivos:[]};if(!cur.motivos.includes(motivo))cur.motivos.push(motivo);found.set(r.eventId||r.id,cur);};
 if(candidato.origen){const k=originKey(candidato.origen);const held=reservas.find(rv=>(rv.id||rv.reservaId)===k);if(held){const ev=docs.find(d=>(d.eventId||d.id)===held.eventId);if(ev)add(ev,'reserva_origen_exacta');}}
 for(const guessed of identidadesCalculadas(candidato)){const hit=docs.find(d=>(d.eventId||d.id)===guessed);if(hit)add(hit,'identidad_calculada');}
 let escaneados=0,exhaustivo=true;
 for(const r of docs){
  if(escaneados>=limite){exhaustivo=false;break;}
  escaneados++;const d=r.data||r;
  const dUrls=[...(d.fuentes||[]).map(s=>s.url),d.link,d.enlace_original].filter(Boolean);
  const dSourceIds=(d.fuentes||[]).map(s=>s.sourceId).filter(Boolean);
  const dTitulo=normalizeText(leg(d,'titulo','nombre')),dCity=normalizeText(leg(d,'city','ciudad')||(typeof d.ubicacion==='string'?d.ubicacion:d.ubicacion?.municipio));
  const dFecha=leg(d,'fechaLocal','fecha_inicio')||d.dateTime?.slice(0,10)||null;
  const otraSesion=(fecha&&dFecha&&dFecha!==fecha)||(candidato.sesionExplicita!==false&&sesion&&d.sesionId&&d.sesionId!==sesion);
  if(urls.length&&dUrls.some(u=>urls.includes(u)))add(r,otraSesion?'url_fuente_otra_sesion':'url_fuente');
  if(sourceIds.length&&dSourceIds.some(s=>sourceIds.includes(s)))add(r,otraSesion?'source_id_otra_sesion':'source_id');
  const cityConflict=city&&dCity&&dCity!==city;
  const sm=motivoSesion(candidato,r);if(sm)add(r,sm);
  const rg=reglaDuplicado(candidato,r);if(rg==='duplicado')add(r,'duplicado_sesion');else if(rg==='parecido')add(r,'posible_duplicado');
  if(title&&fecha&&dFecha===fecha){
   if(dTitulo===title)add(r,city&&dCity&&dCity===city?'titulo_fecha_lugar':'titulo_fecha');
   else if(!cityConflict&&Math.min(dTitulo.length,title.length)>=12&&(dTitulo.includes(title)||title.includes(dTitulo)))add(r,'titulo_contenido');
  }
  if(!title&&city&&fecha&&dCity===city&&dFecha===fecha)add(r,'lugar_fecha');
 }
 const {coincidencias,informativas}=clasificarCoincidencias(found.values());
 return {coincidencias,informativas,escaneados,exhaustivo};
}
