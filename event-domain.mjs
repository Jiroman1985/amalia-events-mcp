import { createHash } from 'node:crypto';

export class DomainError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
export function fail(code, details) { throw new DomainError(code, details); }
/** Plazo máximo de una operación: si vence, error claro (en vez de colgarse hasta el 504 del proxy). El trabajo en curso no se cancela, pero ya no bloquea al llamante. */
export function conPlazo(promesa, ms, code = 'operation_timeout', details = {}) {
  let t; const limite = new Promise((_, rej) => { t = setTimeout(() => rej(new DomainError(code, { segundos: Math.round(ms / 1000), ayuda: 'La operación tardó demasiado y se cortó antes del límite del proxy. Reintenta; si se repite, indica la referencia al administrador.', ...details })), ms); });
  return Promise.race([Promise.resolve(promesa), limite]).finally(() => clearTimeout(t));
}
export async function diagnosticStage(stage, operation, {possiblePartial=false}={}) {
  try { return await operation(); }
  catch (error) {
    const code = error instanceof DomainError ? error.code : 'operation_failed';
    const help = {
      negocio_consulta: 'Consulta el negocio por nombre e identidad antes de reintentar.',
      negocio_guardado: 'El resultado puede ser incierto. Busca el negocio y conserva el mismo requestId antes de reintentar.',
      imagen_descarga: 'La descarga de la imagen falló (mira «causa»: http_403/http_404 = la web la bloquea o no existe; timeout, dns, conexion o certificado = problema de red del servidor remoto). Comprueba la URL en https; si la web la bloquea usa la carga autenticada (subir_imagen_fragmentada).',
      imagen_local: 'Pide al administrador revisar el almacenamiento local; consulta el asset antes de reintentar.',
      imagen_nube: 'Comprueba el almacenamiento y concilia el asset antes de reintentar.',
      imagen_registro: 'La imagen podría estar en almacenamiento. Concilia el registro remoto antes de reintentar.',
      imagen_indice: 'La imagen podría estar guardada. Concilia el registro remoto y el índice local antes de reintentar.'
    };
    throw new DomainError(code, {...(error instanceof DomainError ? error.details : {}), etapa:stage,
      resultado:possiblePartial?'incierto':'sin_escritura_en_esta_etapa', ayuda:help[stage] || 'Consulta el registro y verifica el estado antes de reintentar.'});
  }
}
export function businessReferenceUrl(value) {
 let u;try{u=new URL(value);}catch{fail('invalid_url');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)fail('invalid_business_website',{ayuda:'Usa una dirección web HTTP o HTTPS sin credenciales.'});
 return u.href;
}
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const stable = value => value && typeof value === 'object' ? (Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) ) : value;
export const fingerprint = value => hash(JSON.stringify(stable(value)));
export function id(value) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(value || '')) fail('invalid_id'); return value; }
export function httpsUrl(value) { let u; try { u = new URL(value); } catch { fail('invalid_url'); } if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) fail('https_required'); return u.href; }
export function day(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) fail('invalid_local_date'); return value; }
function clock(value) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')) fail('invalid_local_time'); return value; }
function parts(instant, zone) {
  const v = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date(instant)).map(p => [p.type,p.value]));
  return { date:`${v.year}-${v.month}-${v.day}`, time:`${v.hour}:${v.minute}` };
}
export function localToInstant(date, time, zone) {
  const nominal = Date.parse(`${date}T${time}:00Z`), offsets = new Set();
  for (const delta of [-86400000,0,86400000]) {
    const probe=nominal+delta, p=parts(probe,zone);
    offsets.add(Date.parse(`${p.date}T${p.time}:00Z`)-Math.floor(probe/60000)*60000);
  }
  const candidates=[...offsets].map(o=>nominal-o).filter(t=>{const p=parts(t,zone);return p.date===date && p.time===time;});
  if (!candidates.length) fail('nonexistent_local_time');
  if (candidates.length!==1) fail('ambiguous_time_use_dateTime');
  return new Date(candidates[0]).toISOString();
}
export function schedule(input) {
  const zone=input.timeZone || 'Europe/Madrid';
  try { new Intl.DateTimeFormat('en',{timeZone:zone}); } catch { fail('invalid_time_zone'); }
  let date=input.fechaLocal, time=input.horaLocal || null, instant=null;
  if (input.dateTime) {
    if (!/(Z|[+-]\d\d:\d\d)$/.test(input.dateTime) || !Number.isFinite(Date.parse(input.dateTime))) fail('invalid_datetime');
    instant=new Date(input.dateTime).toISOString(); const p=parts(instant,zone);
    if ((date && date!==p.date) || (time && time!==p.time)) fail('conflicting_local_and_instant');
    date=p.date;time=p.time;
  }
  day(date); if (time) clock(time);
  if (time && !instant) instant=localToInstant(date,time,zone);
  if (input.dateTimeEnd && (!instant || !Number.isFinite(Date.parse(input.dateTimeEnd)) || Date.parse(input.dateTimeEnd)<=Date.parse(instant))) fail('end_must_follow_start');
  const end=input.fechaFinLocal ? day(input.fechaFinLocal) : null;
  if (end && end<date) fail('end_must_follow_start');
  return { fechaLocal:date, horaLocal:time, timeZone:zone, horaDefinida:!!time, horarioTexto:time || 'Sin hora definida', dateTime:instant, fechaFinLocal:end, dateTimeEnd:input.dateTimeEnd ? new Date(input.dateTimeEnd).toISOString() : null };
}
export function sources(input) {
  const list=input.fuentes?.length ? input.fuentes : input.link ? [{url:input.link}] : [];
  if (!list.length) fail('source_required');
  return list.map(s=>{
    const url=httpsUrl(typeof s==='string'?s:s.url);
    let checked=typeof s==='string'?null:s.checkedAt || null;
    if (checked) {
      const t=Date.parse(checked);
      if (!Number.isFinite(t)) fail('invalid_source_checkedAt');
      // Un checkedAt algo futuro suele ser un error de zona horaria del cliente (hora local con «Z»): es metadato, no bloquea; se ajusta a ahora. Más de 48 h es un dato erróneo.
      if (t>Date.now()+48*3600000) fail('invalid_source_checkedAt');
      if (t>Date.now()+60000) checked=null; // determinista: la admisión calcula la propuesta dos veces
    }
    return {url,checkedAt:checked ? new Date(checked).toISOString() : null,sourceId:typeof s==='string'?null:s.sourceId || null};
  });
}
import { resolverValorCategoria, CATEGORIAS as OFICIALES, validarPar } from './catalogo-compartido.mjs';
/** Las 8 categorías oficiales de AMALIA (fuente única: catalogo-compartido, generado desde la web). */
export const CATEGORIAS_OFICIALES=OFICIALES.map(c=>c.nombre);
const TIPOS_UBICACION=['recinto','direccion_aproximada','municipio'];
/** Valor GeoPoint de Firestore (el codificador REST solo sabe mapas). */
export class GeoPunto{constructor(lat,lng){this.latitude=lat;this.longitude=lng;}}
/** Equivalencias canónicas de lo que se envió. Aditivo: `categoria(s)` conserva siempre el valor original. */
function categoryMeta(categorias,categoria){
  const valores=categorias||(categoria?[categoria]:[]);
  const ids=[],revision=[];
  for(const v of valores){const r=resolverValorCategoria(v);
    if(r.tipo==='id'){if(!ids.includes(r.id))ids.push(r.id);}
    else revision.push({valor:v,motivo:r.tipo==='ambigua'?'ambigua':'desconocida',alternativas:r.tipo==='ambigua'?r.alternativas:[]});}
  return {categoriaIds:ids,categoriaRevision:revision};
}
/** Coordenadas con tipo y fuente: nunca se da por buena una ubicación solo porque existe. */
function geoUbicacionDe(g,lugar,city){
  if(g==null)return null;
  if(typeof g!=='object')fail('invalid_geo_location');
  const v=validarPar(g.lat,g.lng);
  if(!v.ok)fail('invalid_coordinates',{motivo:v.motivo,ayuda:'lat y lng deben ser números finitos en rango; el par (0, 0) no es una ubicación'});
  if(!TIPOS_UBICACION.includes(g.tipo))fail('location_type_required',{validos:TIPOS_UBICACION});
  const fuente=typeof g.fuente==='string'?g.fuente.trim():'';
  if(fuente.length<3||fuente.length>200)fail('location_source_required',{ayuda:'Indica de dónde sale la coordenada (p. ej. "web oficial del recinto", "OpenStreetMap")'});
  if(g.tipo==='recinto'&&(!lugar||lugar===city))fail('venue_name_required',{ayuda:'Un recinto exacto necesita el nombre del lugar (lugar), distinto del municipio'});
  let t=g.comprobadoEn?Date.parse(g.comprobadoEn):null;
  let comp=g.comprobadoEn;
  if(t!==null&&!Number.isFinite(t))fail('invalid_location_checkedAt');
  if(t!==null&&t>Date.now()+48*3600000)fail('invalid_location_checkedAt');
  if(t!==null&&t>Date.now()+60000){t=null;comp=null;} // fecha algo futura (zona horaria del cliente): se usa la de hoy
  // Determinista: la admisión calcula la propuesta dos veces; una hora exacta por omisión rompería su hash (proposal_changed).
  return {lat:v.par.lat,lng:v.par.lng,tipo:g.tipo,fuente,comprobadoEn:t===null?parts(Date.now(),'Europe/Madrid').date:/^\d{4}-\d{2}-\d{2}$/.test(comp)?comp:new Date(t).toISOString()};
}
/** Campos que lee la web para pintar el pin: recinto→geo+lugar, municipio→geo+ciudad, dirección→lat/lng. */
export function geoCampos(g){
  if(!g)return {};
  if(g.tipo==='direccion_aproximada')return {geo:null,geo_precision:null,geo_fuente:null,lat:g.lat,lng:g.lng};
  return {geo:new GeoPunto(g.lat,g.lng),geo_precision:g.tipo==='recinto'?'lugar':'ciudad',geo_fuente:g.fuente,lat:null,lng:null};
}
export const CATEGORIAS=['Fiestas locales','Cultura','Música y festivales','Gastronomía','Planes familiares y con niños','Aventura y naturaleza','Bienestar','Arte y creatividad','Negocios y networking'];
export const normalizeText=v=>String(v||'').normalize('NFKD').replace(/\p{M}/gu,'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const ORIGEN_ID=v=>{const s=String(v??'').trim();if(!s||s.length>300)fail('invalid_origin');return s;};
export function origin(input) {
  if (input.origen==null) return null;
  const o=input.origen;
  if (typeof o!=='object') fail('invalid_origin');
  const proveedor=ORIGEN_ID(o.proveedor),idExterno=ORIGEN_ID(o.id_externo),idSesion=ORIGEN_ID(o.id_sesion);
  return {proveedor,id_externo:idExterno,id_sesion:idSesion};
}
export const originKey=o=>'res_'+hash([o.proveedor,o.id_externo,o.id_sesion].join('\0')).slice(0,40);
function priceInfo(input) {
  const p=input.precioInfo;
  if (p==null) {
    if (input.precio==null) return {precio:null,precioEstado:'desconocido',precioDetalle:null};
    if (typeof input.precio!=='number'||input.precio<0) fail('invalid_price');
    if (input.precio===0) return {precio:null,precioEstado:'desconocido',precioDetalle:null};
    return {precio:input.precio,precioEstado:'precio',precioDetalle:null};
  }
  const estado=p.estado;
  if (!['gratis','precio','desde','rango','condicionado','desconocido'].includes(estado)) fail('invalid_price_status');
  const cantidad=p.cantidad??null,cantidadMax=p.cantidadMax??null;
  for (const c of [cantidad,cantidadMax]) if (c!=null && (typeof c!=='number'||c<0)) fail('invalid_price');
  if (estado==='desconocido' && (cantidad!=null||cantidadMax!=null)) fail('unknown_price_has_amount');
  if (estado==='gratis' && ((cantidad??0)!==0||cantidadMax!=null)) fail('free_price_has_amount');
  if (['precio','desde','condicionado'].includes(estado) && cantidad==null) fail('price_amount_required');
  if (estado==='rango' && (cantidad==null||cantidadMax==null||cantidadMax<cantidad)) fail('price_range_invalid');
  const detalle={estado,cantidad,cantidadMax,moneda:p.moneda||null,condiciones:p.condiciones||null,textoOriginal:p.textoOriginal??null};
  return {precio:estado==='desconocido'?null:(cantidad??0),precioEstado:estado,precioDetalle:detalle};
}
/** Lista de sesiones de una ficha: [{fechaLocal, horaLocal, horaFinLocal}] ordenada, sin repetidas (2 a 60). */
export function normSesiones(lista) {
  if (!Array.isArray(lista)||lista.length<2||lista.length>60) fail('too_many_sessions',{minimo:2,maximo:60});
  const hh=v=>{if(v==null||v==='')return null;const m=/^(\d{1,2}):(\d{2})$/.exec(String(v).trim());if(!m||+m[1]>23||+m[2]>59)fail('invalid_session',{hora:v});return m[1].padStart(2,'0')+':'+m[2];};
  const out=lista.map((x,i)=>{const f=String(x.fechaLocal??x.fecha_local??'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(f))fail('invalid_session',{indice:i+1,fecha:f});return {fechaLocal:f,horaLocal:hh(x.horaLocal??x.hora_local),horaFinLocal:hh(x.horaFinLocal??x.hora_fin_local)};});
  const vistos=new Set();for(const [i,x] of out.entries()){const k=x.fechaLocal+'|'+(x.horaLocal||'');if(vistos.has(k))fail('duplicate_sessions_in_call',{indice:i+1,fechaLocal:x.fechaLocal,horaLocal:x.horaLocal});vistos.add(k);}
  return out.sort((a,b)=>(a.fechaLocal+(a.horaLocal||''))<(b.fechaLocal+(b.horaLocal||''))?-1:1);
}
function temporality(input) {
  const t=input.temporalidad;
  if (t==null) return {temporalidadTipo:null,temporalidadTexto:null,overrides:null};
  if (typeof t!=='object') fail('invalid_temporality');
  if (t.tipo==='periodo_venta') fail('sales_window_not_session',{ayuda:'Una ventana de venta no prueba sesiones: guarda un candidato con guardar_candidato o aporta fechas verificadas.'});
  if (!['sesiones','periodo'].includes(t.tipo)) fail('invalid_temporality');
  let overrides=null,sesionesLista=null;
  if (t.tipo==='sesiones') {
    const sesiones=t.sesiones;
    if (!Array.isArray(sesiones)||!sesiones.length) fail('invalid_temporality');
    if (sesiones.length>1) {
      // Una ficha con varias sesiones exige una identidad estable (sesionId u origen); sin ella, una llamada por sesión (o el lote de preparar_admision).
      if (!input.sesionId&&!input.origen) fail('multiple_sessions_split_calls',{sesiones:sesiones.length,ayuda:'Para guardar todas las sesiones en UNA ficha indica un sesionId estable (o origen). Sin él, preparar_admision/admitir_candidato crean una ficha por sesión.'});
      sesionesLista=normSesiones(sesiones);
      const f=sesionesLista[0];
      overrides={fechaLocal:f.fechaLocal,horaLocal:f.horaLocal,timeZone:sesiones[0].zona||sesiones[0].timeZone||input.timeZone};
      const ultima=sesionesLista.at(-1).fechaLocal;if(ultima>f.fechaLocal&&input.fechaFinLocal==null)overrides.fechaFinLocal=ultima;
    } else {
    const s=sesiones[0];
    overrides={fechaLocal:s.fechaLocal??s.fecha_local,horaLocal:s.horaLocal??s.hora_local??null,timeZone:s.zona||s.timeZone||input.timeZone};
    }
  }
  return {temporalidadTipo:t.tipo,temporalidadTexto:t.textoOriginal??t.texto_original??null,overrides,sesionesLista};
}
export const ETIQUETAS=['musica','teatro','flamenco','humor','exposicion','fiesta','mercado','visita','cine','taller','cata','senderismo','ninos','interior','aire_libre','accesible'];
export const FUENTE_TIPOS=['oficial','plataforma','otra'];
/** Campos opcionales de la ficha pública. Solo existen en el resultado si se aportan: así no cambian las huellas de eventos ya admitidos. */
function fichaExtras(merged,geo){
  const out={};
  if(merged.etiquetas!=null){
    if(!Array.isArray(merged.etiquetas)||merged.etiquetas.length>8)fail('invalid_tags',{validas:ETIQUETAS,maximo:8});
    const bad=merged.etiquetas.filter(t=>!ETIQUETAS.includes(t));
    if(bad.length)fail('invalid_tags',{rechazadas:bad,validas:ETIQUETAS,maximo:8});
    if(new Set(merged.etiquetas).size!==merged.etiquetas.length)fail('invalid_tags',{motivo:'repetidas',validas:ETIQUETAS,maximo:8});
    if(merged.etiquetas.length)out.etiquetas=[...merged.etiquetas];
  }
  const dir=geo.direccion??merged.direccion;
  if(dir!=null){
    if(typeof dir!=='string')fail('invalid_address');
    const d=dir.trim().replace(/\s+/g,' ');
    if(d.length>200||/[\u0000-\u001f\u007f]/.test(d))fail('invalid_address',{maximo:200});
    if(geo.direccion!=null&&merged.direccion!=null&&normalizeText(geo.direccion)!==normalizeText(merged.direccion))fail('conflicting_address');
    if(d)out.direccion=d;
  }
  if(merged.fuente_nombre!=null){
    const n=typeof merged.fuente_nombre==='string'?merged.fuente_nombre.trim():'';
    if(n.length<2||n.length>80||/[\u0000-\u001f\u007f]/.test(n))fail('invalid_source_name',{maximo:80});
    out.fuente_nombre=n;
  }
  if(merged.fuenteId!=null){
    const f=typeof merged.fuenteId==='string'?merged.fuenteId.trim():'';
    if(!/^(fte_[a-z]+_[0-9a-f]{24}|F-[A-Z0-9]{2,6}-\d{3,5})$/.test(f))fail('invalid_source_id',{ayuda:'fuenteId: el id de la fuente en el registro de fuentes (fte_… o F-XXX-0000), el que devuelve buscar_fuente/registrar_fuente.'});
    out.fuenteId=f;
  }
  if(merged.fuente_tipo!=null){
    if(!FUENTE_TIPOS.includes(merged.fuente_tipo))fail('invalid_source_type',{validos:FUENTE_TIPOS});
    out.fuente_tipo=merged.fuente_tipo;
  }
  return out;
}
function geography(input) {
  const u=input.ubicacion;
  if (u==null||typeof u==='string') return {city:u||input.city,lugar:input.lugar,provincia:input.provincia||null,pais:input.pais||null,direccion:null};
  if (typeof u!=='object') fail('invalid_location');
  if (u.municipio && input.city && normalizeText(u.municipio)!==normalizeText(input.city)) fail('conflicting_location');
  return {city:u.municipio||input.city,lugar:u.lugar||input.lugar,provincia:u.provincia||null,pais:u.pais||null,direccion:u.direccion??null};
}
/**
 * Alta nueva (preparar_admision / admitir_candidato): exige fechaLocal en formato ISO, municipio y provincia, y que city/town/ciudad/municipio,
 * si vienen, coincidan entre sí. Cada fallo dice qué campo falta o no cuadra. Las ediciones de eventos existentes no pasan por aquí.
 */
export function assertAltaCompleta(input) {
  const txt=v=>typeof v==='string'?v.trim():'',falta=(campo,ayuda)=>fail('missing_field',{campo,ayuda});
  const u=input.ubicacion,uObj=u&&typeof u==='object'?u:null,uTxt=typeof u==='string'?u:'';
  const t=input.temporalidad,s0=t&&typeof t==='object'&&Array.isArray(t.sesiones)?t.sesiones[0]:null;
  const fecha=txt(s0?(s0.fechaLocal??s0.fecha_local):input.fechaLocal);
  if (!fecha&&!txt(input.dateTime)) falta('fechaLocal','Falta fechaLocal (formato ISO AAAA-MM-DD, p. ej. 2026-12-05) o temporalidad con sesiones.');
  if (fecha&&!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fail('invalid_local_date',{campo:'fechaLocal',valor:fecha.slice(0,40),ayuda:'fechaLocal debe ir en formato ISO AAAA-MM-DD (p. ej. 2026-12-05).'});
  const ref=[['ubicacion.municipio',uObj?.municipio],['ubicacion',uTxt],['municipio',input.municipio],['city',input.city]].map(([c,v])=>[c,txt(v)]).find(([,v])=>v);
  if (!ref) falta('municipio','Falta el municipio: indica city (o ubicacion.municipio) con el municipio del evento.');
  for (const [campo,v] of [['city',input.city],['town',input.town],['ciudad',input.ciudad],['municipio',input.municipio],['ubicacion',uTxt],['ubicacion.municipio',uObj?.municipio]]) {
    const x=txt(v); if (x&&normalizeText(x)!==normalizeText(ref[1])) fail('conflicting_location',{campo,valor:x.slice(0,120),municipio:ref[1].slice(0,120),ayuda:'«'+campo+'» debe coincidir con el municipio ('+ref[0]+' = '+ref[1].slice(0,120)+').'});
  }
  if (txt(uObj?uObj.provincia:input.provincia).length<2&&txt(input.provincia).length<2) falta('provincia','Falta la provincia: indica provincia (o ubicacion.provincia), p. ej. «Granada».');
}
export function canonicalInput(input,opts={}) {
  const geo=geography(input),temp=temporality(input);
  const merged=temp.overrides?{...input,...Object.fromEntries(Object.entries(temp.overrides).filter(([,v])=>v!==undefined))}:input;
  const titulo=String(merged.titulo || '').trim(),descripcion=String(merged.descripcion || '').trim(),city=String(geo.city || '').trim();
  if (titulo.length<2 || titulo.length>180 || descripcion.length<2 || descripcion.length>5000 || city.length<2) fail('invalid_event');
  const temporal=schedule(merged),fuentes=sources(merged),negocioId=id(merged.negocioId);
  const org=origin(merged);
  let sesionId=merged.sesionId?.trim(),sesionExplicita=merged.sesionExplicita ?? !!merged.sesionId;
  if (org) { sesionId=org.id_sesion; sesionExplicita=true; }
  // Una hora desconocida no impide capturar: la identidad conserva fecha, fuente y título.
  // Las posibles sesiones repetidas de la misma fecha siguen sujetas a deduplicación y revisión.
  sesionId=sesionId || `${temporal.fechaLocal}/${temporal.horaLocal || 'sin-hora'}`;
  if (!sesionId || sesionId.length>180) fail('invalid_session');
  if (org && !fuentes[0].sourceId) fuentes[0]={...fuentes[0],sourceId:org.id_externo};
  const price=priceInfo(merged);
  let categorias=null;
  if (merged.categorias!=null) {
    if (!Array.isArray(merged.categorias)||!merged.categorias.length||merged.categorias.length>4) fail('invalid_categories');
    if(!opts.preservarCategorias)for (const c of merged.categorias) if (resolverValorCategoria(c).tipo==='desconocida') fail('unknown_category',{categoria:c,revision:true,validas:CATEGORIAS_OFICIALES});
    categorias=[...new Set(merged.categorias)];
  }
  const categoria=categorias?categorias[0]:(merged.categoria || null);
  const tipo=merged.tipo||'evento';
  if (!['evento','experiencia'].includes(tipo)) fail('invalid_type');
  const geoE=geoUbicacionDe(merged.geoUbicacion,(geo.lugar??merged.lugar)?.trim()||null,city);
  return {titulo,descripcion,city,negocioId,marcaId:merged.marcaId || null,...temporal,sesionId,sesionExplicita,fuentes,link:merged.link ? httpsUrl(merged.link) : fuentes[0].url,lugar:(geo.lugar??merged.lugar)?.trim() || city,provincia:geo.provincia??merged.provincia??null,pais:geo.pais??merged.pais??null,categoria,categorias,tipo,...price,temporalidadTipo:temp.temporalidadTipo??merged.temporalidadTipo??null,temporalidadTexto:temp.temporalidadTexto??merged.temporalidadTexto??null,...(temp.sesionesLista||merged.sesiones?{sesiones:temp.sesionesLista||normSesiones(merged.sesiones)}:{}),origen:org,aforo:merged.aforo ?? null,assetId:merged.assetId || null,image:merged.image || null,sourceImageUrl:merged.sourceImageUrl || merged.image || null,sustainableTip:merged.sustainableTip || null,publicTransport:merged.publicTransport || null,verificationStatus:merged.verificationStatus || 'capturado',conflictos:merged.conflictos || [],cta:merged.cta || null,prueba:merged.prueba===true,...(opts.preservarCategorias?{}:categoryMeta(categorias,merged.categoria||null)),...(geoE?{geoUbicacion:geoE}:{}),...fichaExtras(merged,geo)};
}
export function eventIdentity(e) { return 'ev_'+hash([e.negocioId,e.fuentes[0].sourceId || e.fuentes[0].url,e.sesionId,e.sesionExplicita?'':e.fechaLocal,e.sesionExplicita?'':e.horaLocal || '',e.sesionExplicita?'':e.titulo.normalize('NFKC').toLowerCase()].join('\0')).slice(0,32); }
import { agenteCanonico } from './identidad.mjs';
export function record(e, principal, now=new Date().toISOString()) {
  if (!['capturado','verificado','cancelado'].includes(e.verificationStatus)) fail('invalid_verification_status');
  if (e.prueba===true && e.verificationStatus==='verificado') fail('test_event_not_verified');
  if (e.verificationStatus==='verificado' && (e.fuentes.some(s=>!s.checkedAt) || e.conflictos.length)) fail('event_not_verified');
  if (e.verificationStatus==='verificado' && !e.fuentes.some(s=>s.url===e.link))fail('ticket_link_not_verified');
  return {...e,schemaVersion:2,managedBy:'amalia-events-v2',precision_temporal:e.horaDefinida?'fecha_hora':'fecha',fecha_inicio:e.fechaLocal,fecha_fin:e.fechaFinLocal,hora:e.horaLocal,nombre:e.titulo,description:e.descripcion,ubicacion:e.city,town:e.city,place:e.lugar,uidNegocio:e.negocioId,marca:e.marcaId,category:e.categoria,imagen:e.image,enlace_original:e.link,'local-sustainable-tip':e.sustainableTip,'public-transport':e.publicTransport,fechaCreacion:now,fechaActualizacion:now,createdBy:principal.id,agenteCanonico:agenteCanonico(principal.id),updatedBy:agenteCanonico(principal.id),updatedByPrincipal:principal.id,version:1,metrics:{views:0,clicks:0,interactions:0},...geoCampos(e.geoUbicacion)};}
export function authorize(principal,business,action='read') {
  if (!principal) fail('unauthorized');
  if (!principal.actions.includes('*') && !principal.actions.includes(action)) fail('forbidden',{accionRequerida:action,ayuda:'Tu token no tiene la acción «'+action+'». Pídesela a Alfred; no es un error de campo.'});
  if (business && !principal.businesses.includes('*') && !principal.businesses.includes(business)) fail('business_forbidden');
}
// Admission also permits its preparatory media/private-candidate work, never direct event creation.
export function authorizeCapture(principal,business) {
  authorize(principal,business,principal?.actions?.includes('admit')?'admit':'create');
}
export function publishableEvent(e,now=Date.now()) {
  if (e.retirado===true) fail('event_retired');
  if (e.verificationStatus!=='verificado' || e.conflictos?.length) fail('event_not_verified');
  const today=parts(now,e.timeZone || 'Europe/Madrid').date;
  if ((e.fechaFinLocal || e.fechaLocal)<today || (e.dateTimeEnd && Date.parse(e.dateTimeEnd)<now)) fail('event_expired');
}

/** Valida solo los campos opcionales de ficha (candidatos privados). */
export function canonicalInputExtras(input){return fichaExtras(input,{direccion:input.ubicacion&&typeof input.ubicacion==='object'?input.ubicacion.direccion??null:null});}

/** Fuentes que solo sirven de comprobación (tiempo, mapas, agregadores): el mapa muestra como fuente la primera que NO sea de este tipo. */
const COMPROBACION_HOST=[/(^|\.)aemet\.es$/,/(^|\.)google\.[a-z.]+$/,/^goo\.gl$/,/^g\.co$/,/(^|\.)feverup\.com$/,/(^|\.)fever\.com$/,/^amalia\.link$/];
export function esFuenteComprobacion(url){
  let u;try{u=new URL(typeof url==='string'?url:url?.url);}catch{return false;}
  const h=u.hostname.toLowerCase().replace(/^www\./,'');
  if(COMPROBACION_HOST.some(r=>r.test(h)))return true;
  return /(^|\.)amalia-experience\.com$/.test(h)&&/^\/(l|r|s|go|e)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname);
}
/** La primera fuente debe ser la página del organizador o de la agenda. */
export function assertFuentePrimaria(fuentes){
  if(fuentes?.length&&esFuenteComprobacion(fuentes[0]))fail('source_primary_not_organizer',{primera:fuentes[0].url,ayuda:'Pon primero la página del organizador o de la agenda del evento; las fuentes de comprobación (AEMET, Google, Fever, enlaces cortos de AMALIA) van después y nunca solas.'});
}
/** Fusiona fuentes sin quitar ninguna: las nuevas van al final y checkedAt solo se actualiza. Si la primera es de comprobación y llega una de organizador, esta pasa a primera. */
export function mergeSources(actuales,nuevas){
  const out=(actuales||[]).map(s=>({...s}));
  for(const n of sources({fuentes:nuevas})){
    const i=out.findIndex(s=>s.url===n.url);
    if(i<0)out.push(n);
    else{if(n.checkedAt&&(!out[i].checkedAt||Date.parse(n.checkedAt)>Date.parse(out[i].checkedAt)))out[i].checkedAt=n.checkedAt;if(n.sourceId&&!out[i].sourceId)out[i].sourceId=n.sourceId;}
  }
  if(out.length&&esFuenteComprobacion(out[0])){const j=out.findIndex(s=>!esFuenteComprobacion(s));if(j>0)out.unshift(...out.splice(j,1));}
  return out;
}
const MESES='enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
/** Un título «cambia de forma» si solo varían mayúsculas, signos, fechas o la ciudad incrustados. */
export function tituloBase(titulo,city){
  let t=normalizeText(titulo);
  t=t.replace(new RegExp('\\b\\d{1,2}(\\s+de)?\\s+('+MESES+')(\\s+(de\\s+)?\\d{4})?\\b','g'),' ').replace(/\b\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?\b/g,' ').replace(/\b(19|20)\d{2}\b/g,' ');
  // city puede ser una ciudad o varias (la anterior y la nueva): se quitan de la más larga a la más corta («El Viso del Alcor» antes que «El Viso»).
  for(const c of [...new Set([].concat(city||[]).map(normalizeText).filter(Boolean))].sort((a,b)=>b.length-a.length))t=t.replace(new RegExp('\\b(en\\s+)?'+c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','g'),' ');
  return t.replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
export const tituloSoloForma=(antes,despues,city)=>{const a=tituloBase(antes,city),b=tituloBase(despues,city);return a.length>0&&a===b;};
