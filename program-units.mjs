import {parse} from './program-html.mjs';
import {hash,normalizeText,fail,day,canonicalInput} from './event-domain.mjs';
export const attr=(n,k)=>n.attrs?.find(a=>a.name===k)?.value||'';
export const has=(n,c)=>attr(n,'class').split(/\s+/).includes(c);
export function all(n,f,out=[]){if(f(n))out.push(n);for(const c of n.childNodes||[])all(c,f,out);return out;}
export const visible=n=>n.nodeName==='#text'?n.value:['script','style','noscript','template'].includes(n.tagName)||n.attrs?.some(a=>a.name==='hidden')||/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(n,'style'))?'':(n.childNodes||[]).map(visible).join(' ');
export const clean=s=>String(s).replace(/\s+/g,' ').trim();
export const text=n=>clean(visible(n));
export const tree=html=>parse(html);
export function links(n,base){return all(n,n=>n.tagName==='a'&&attr(n,'href')).flatMap(a=>{try{return [{url:new URL(attr(a,'href'),base).href,text:text(a)}];}catch{return [];}});}
const MONTHS={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12,ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,oct:10,nov:11,dic:12};
const iso=(y,m,d)=>day(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
const normalizedTitle=s=>normalizeText(clean(s)).replace(/[“”"'¿?¡!.,:;]+/g,'').trim();
export const titleKey=s=>normalizedTitle(s);
const clock=s=>{const m=s.match(/^(\d{1,2})[:.](\d{2})$/);if(!m||+m[1]>23||+m[2]>59)fail('source_time_invalid');return `${m[1].padStart(2,'0')}:${m[2]}`;};
const timePrefix=/^(\d{1,2}[:.]\d{2})\s*h?\s*(?:[-–—]\s*(\d{1,2}[:.]\d{2})\s*h?)?\s*[.:]?\s*/i;
const logistical=s=>/^(?:salida (?:del? )?autob[uú]s|comida\b|llegada\b|desplazamiento\b)/i.test(clean(s));
const cancellation=s=>/\b(?:cancelad[oa]s?|anulad[oa]s?|suspendid[oa]s?)\b/i.test(s);
function geography(title,body){
 const rows=body.map(clean).filter(s=>!/(?:salida|autob[uú]s|llegada|comida)/i.test(s));
 const placeRows=rows.filter(s=>/^(?:Lugar(?: de celebraci[oó]n de la actividad)?|Punto de encuentro):/i.test(s));
 if(placeRows.length>1)fail('source_location_ambiguous');
 const inline=title.match(/\b(?:en|de)\s+([A-ZÁÉÍÓÚÑ][\p{L}-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}-]+){0,3})\s*\((Salamanca)\)/u);
 const place=placeRows[0]?.replace(/^[^:]+:\s*/,'')|| (inline?title:null);
 let city=inline?.[1]?.trim()||null,province=inline?.[2]||null;
 if(placeRows[0]){const named=place.match(/^([\p{L}][\p{L} -]+?)\s*\((Salamanca)\)\.?$/u);if(named&&!/\b(?:Aula|Facultad|Edificio|Centro|Museo|Calle|USAL)\b/i.test(named[1])&&named[1].split(/\s+/).length<=3){if(city&&normalizeText(city)!==normalizeText(named[1]))fail('source_location_conflict');city=named[1].trim();province=named[2];}
 else if(/\(Salamanca\)\.?$/i.test(place)){if(city&&city!=='Salamanca')fail('source_location_conflict');city='Salamanca';province='Salamanca';}}
 return {city,lugar:place,provincia:province,pais:city&&province?'ES':null,timeZone:city&&province?'Europe/Madrid':null};
}
function unit({url,title,body,date,hour,end,kind='sesion',free=false,extra={}}){
 const geo=geography(title,body),description=clean([title,...body.filter(s=>!/^M[aá]s informaci[oó]n|^(?:MAÑANA|TARDE)$/i.test(s)&&!/(?:autob[uú]s|salida|llegada|comida)/i.test(s))].join(' '));
 const missing=[];if(!geo.city)missing.push('municipio_no_acreditado');if(!geo.lugar)missing.push('lugar_no_acreditado');if(!geo.timeZone)missing.push('zona_horaria_no_acreditada');if(!date)missing.push('fecha_no_acreditada');if(free&&/(?:\d+\s*(?:€|euros)|precio\s*:)/i.test([title,...body].join(' ')))missing.push('precio_fuente_conflictivo');if(/^no\b/i.test(title))missing.push('actividad_negada');if(cancellation([title,...body].join(' ')))missing.push('fuente_cancelada');if(kind==='rango')missing.push('horario_semanal_no_representable');
 if(title.length<2||title.length>180||description.length<2||description.length>5000)missing.push('texto_fuera_de_esquema');
 const facts={titulo:clean(title),descripcion:description,fechaLocal:date,horaLocal:hour,fechaFinLocal:null,dateTimeEnd:end&&date&&geo.timeZone?canonicalInput({negocioId:'fixture',titulo:title,descripcion:description,city:geo.city,fechaLocal:date,horaLocal:end,timeZone:geo.timeZone,sesionId:'s',fuentes:[{url}]}).dateTime:null,...geo,tipo:'evento',precioInfo:free?{estado:'gratis',cantidad:0,textoOriginal:free}:{estado:'desconocido'},aforo:null,...extra};
 // A semantic unit key excludes position AND dates/times. Repeated same title/place is ambiguous.
 const unidadId='unit_'+hash([url,titleKey(title),normalizeText(geo.city||''),kind].join('\0')).slice(0,32);
 return {unidadId,sourceUrl:url,kind,facts,carencias:missing,factsHash:hash(facts)};
}
export function extractProgram(snapshot){
 const doc=tree(snapshot.body),accordion=all(doc,n=>has(n,'x-acc-item'));
 if(!accordion.length)fail('program_template_unsupported');
 const main=all(doc,n=>has(n,'entry-content'))[0];if(!main)fail('program_scope_missing');
 const paragraphs=all(main,n=>n.tagName==='p');
 const periods=paragraphs.map(n=>text(n)).flatMap(s=>[...s.matchAll(/se (?:celebrar[aá]|celebra) del (\d{1,2}) al (\d{1,2}) de ([a-z]+) de (20\d{2})/gi)].map(m=>({from:+m[1],to:+m[2],month:MONTHS[normalizeText(m[3])],year:+m[4]})));
 const free=paragraphs.map(text).find(s=>/^Todas las actividades\b.*completamente gratuitas\./i.test(s))||false;
 const units=[];
 for(const section of accordion){
  const nodes=all(section,n=>['h5','h6','p'].includes(n.tagName));if(!nodes.length)fail('program_section_empty');
  const header=text(nodes[0]),dateMatch=header.match(/^(?:Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes|S[aá]bado|Domingo),?\s*(\d{1,2}) de ([a-z]+)(?: de (20\d{2}))?/i);
  let date=null;
  if(dateMatch){const month=MONTHS[normalizeText(dateMatch[2])],d=+dateMatch[1];let year=dateMatch[3];if(!year){const matches=periods.filter(p=>p.month===month&&d>=p.from&&d<=p.to);if(matches.length!==1)fail('program_year_ambiguous');year=matches[0].year;}date=iso(year,month,d);}
  else if(!/^EXPOSICIONES$/i.test(header))fail('program_day_unsupported');
  let current=null;
  const flush=()=>{if(current)units.push(unit({...current,url:snapshot.finalUrl,free}));current=null;};
  for(const node of nodes.slice(1)){
   const s=text(node);if(!s)continue;
   const t=s.match(timePrefix),following=/^A continuaci[oó]n:\s*/i.test(s);
   if(t||following||(!date&&node.tagName==='h5')){
    flush();let title=s,hour=null,end=null,kind=date?'sesion':'rango';
    if(t){title=s.slice(t[0].length);hour=clock(t[1]);end=t[2]?clock(t[2]):null;}
    if(following)title=title.replace(/^A continuaci[oó]n:\s*/i,'');
    let remainder=null;if(node.tagName==='p'&&!following){const split=title.match(/^(.+?\.)\s+([A-ZÁÉÍÓÚÑ].*)$/u);if(split){title=split[1];remainder=split[2];}}
    if(logistical(title)){current=null;continue;}
    current={title,body:remainder?[remainder]:[],date,hour,end,kind};
   }else if(current&&node.tagName!=='h6'&&!/^(?:MAÑANA|TARDE)$/i.test(s))current.body.push(s);
  }flush();
 }
 if(!units.length)fail('program_units_missing');const ids=new Set();for(const u of units){if(ids.has(u.unidadId))fail('program_unit_ambiguous');ids.add(u.unidadId);}return units;
}
export function extractConvocation(snapshot,programUrl){
 const doc=tree(snapshot.body),titleNode=all(doc,n=>n.tagName==='h1')[0],groups=all(doc,n=>has(n,'paragraph--type--convocatoria'));
 if(!titleNode||groups.length!==1)fail('convocation_template_unsupported');const g=groups[0];
 const field=name=>{const a=all(g,n=>has(n,'field--name-field-'+name));if(a.length!==1)fail('convocation_field_ambiguous',{field:name});return a[0];};
 const dateNode=field('fecha'),dt=all(dateNode,n=>n.tagName==='time');if(dt.length!==1)fail('convocation_date_missing');
 const literal=text(dateNode).match(/^(\d{1,2})\s+([\p{L}]+)\s+(20\d{2})$/u);if(!literal)fail('convocation_visible_date_invalid');const date=iso(literal[3],MONTHS[normalizeText(literal[2])],literal[1]);
 if(attr(dt[0],'datetime').slice(0,10)!==date)fail('convocation_attribute_conflict');
 const rawHour=text(field('hora')),hourMatch=rawHour.match(/^(\d{1,2}[:.]\d{2})(?::00)?\s*(?:horas|h\.?)?$/i);if(!hourMatch)fail('convocation_visible_time_invalid');
 const city=text(field('nombre')),lugar=text(field('lugar'));
 // The Drupal noon datetime is a DATE placeholder; only visible field-hora proves the time.
 const u=unit({url:snapshot.finalUrl,title:text(titleNode),body:['Lugar: '+lugar+' ('+city+')'],date,hour:clock(hourMatch[1]),free:false});
 const body=all(doc,n=>has(n,'field--name-field-noticia-contenido'))[0];if(!body)fail('convocation_body_missing');
 u.facts.descripcion=text(body);if(u.facts.descripcion.length<2||u.facts.descripcion.length>5000)u.carencias.push('descripcion_fuera_de_esquema');u.factsHash=hash(u.facts);u.programUrl=programUrl;return u;
}
