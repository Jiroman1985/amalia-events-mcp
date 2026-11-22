import {ProgramCapture} from './program-capture.mjs';
import {all,has,attr,text,tree,links,extractProgram,extractConvocation,titleKey,clean} from './program-units.mjs';
import {canonicalInput,hash,fingerprint,normalizeText,fail} from './event-domain.mjs';
const DIRECTORY='https://www.educa.jcyl.es/universidad/es/directorio-universidades/universidades-castilla-leon/';
const root=h=>h.toLowerCase().replace(/^www\./,'');
const belongs=(h,r)=>root(h)===r||h.endsWith('.'+r);
const equal=(a,b)=>fingerprint(a)===fingerprint(b);
const sourceList=e=>[...(e.fuentes||[]).map(s=>s.url),e.link,e.enlace_original].filter(Boolean);
const timing=e=>e.fechaLocal||e.fecha_inicio||e.dateTime?.slice(0,10)||null;
export function validateSnapshot(capture,key){
 if(!capture||!Array.isArray(capture.hops)||!capture.hops.length||capture.hops.length>4)fail('program_snapshot_corrupt');
 for(const h of capture.hops){if(typeof h.rawBase64!=='string'||Buffer.from(h.rawBase64,'base64').toString('base64')!==h.rawBase64)fail('program_snapshot_corrupt');const bytes=Buffer.from(h.rawBase64,'base64');if(hash(bytes)!==h.sha256||bytes.toString('utf8')!==h.body||(h.bytes!=null&&h.bytes!==bytes.length))fail('program_snapshot_corrupt');}
 const digest=hash(capture.hops.map(h=>({url:h.url,status:h.status,sha256:h.sha256,location:h.headers?.location??null})));
 if(capture.digest!==digest||key!=='snapshot_'+digest||capture.originalUrl!==capture.hops[0].url||capture.finalUrl!==capture.hops.at(-1).url||capture.body!==capture.hops.at(-1).body||capture.hops.at(-1).status!==200)fail('program_snapshot_corrupt');
 return true;
}
export class ProgramAdmission {
 constructor(store,{capture=new ProgramCapture()}={}){this.store=store;this.capture=capture;}
 async load(p,business){
  const AYUDA_ALTERNATIVA='Si el organizador es un ayuntamiento, una asociación u otro que NO sea la Universidad de Salamanca, no uses este modo: haz el alta ordinaria con preparar_admision y admitir_candidato, UNA llamada por sesión (cada cata o actividad con su fechaLocal, horaLocal, sesionId propio y la URL de la página como fuente). Compartir URL con otras sesiones ya no bloquea: solo bloquea lo que coincide en nombre, fecha, lugar y hora.';
  if(!p||typeof p!=='object'||!p.url||!p.directorioUrl||!p.enlaceInstitucionalUrl)fail('program_provenance_required',{faltan:['url','directorioUrl','enlaceInstitucionalUrl'].filter(k=>!p||typeof p!=='object'||!p[k]),ayuda:'preparar_programa_oficial exige url (página del programa), directorioUrl (ficha de la universidad en el directorio de la Junta de Castilla y León) y enlaceInstitucionalUrl (página de servicio de la universidad). '+AYUDA_ALTERNATIVA,alternativa:'preparar_admision'});
  if(!p.directorioUrl.startsWith(DIRECTORY)||!/^[-a-z]+$/.test(p.directorioUrl.slice(DIRECTORY.length)))fail('authority_directory_unsupported',{recibido:String(p.directorioUrl).slice(0,200),autoridadSoportada:'Universidades de Castilla y León según el directorio de la Junta (hoy solo se acredita el programa de la Universidad de Salamanca)',directorioUrlDebeEmpezarPor:DIRECTORY,directorioUrlDebeTerminarEn:'<nombre-de-la-universidad> (solo letras minúsculas y guiones)',ayuda:'El directorioUrl no pertenece a ninguna autoridad soportada, y este modo solo valida programas de esas universidades. '+AYUDA_ALTERNATIVA,alternativa:'preparar_admision'});
  const directory=await this.capture.capture(p.directorioUrl),dt=tree(directory.body);
  if(directory.finalUrl!==p.directorioUrl)fail('authority_directory_redirect');
  const items=all(dt,n=>has(n,'modelItem'));const web=items.flatMap(n=>all(n,n=>n.tagName==='li'&&all(n,x=>x.tagName==='img'&&attr(x,'alt')==='Web').length).flatMap(n=>links(n,directory.finalUrl)));
  const hosts=[...new Set(web.map(l=>root(new URL(l.url).hostname)))];if(hosts.length!==1)fail('authority_directory_ambiguous');const institution=hosts[0];
  const serviceUrl=new URL(p.enlaceInstitucionalUrl);if(root(serviceUrl.hostname)!==institution||serviceUrl.protocol!=='https:'||serviceUrl.search)fail('institution_service_unanchored');
  const site=business.data.fuentesInformacion?.sitioWeb||business.data.sitioWeb;if(!site||!belongs(new URL(site).hostname,institution)||business.data.estado!=='activo')fail('institution_business_mismatch');
  const service=await this.capture.capture(serviceUrl.href),st=tree(service.body);const serviceNodes=all(st,n=>has(n,'node-usal-servicio'));if(serviceNodes.length!==1)fail('institution_service_template_unsupported');
  const contact=all(serviceNodes[0],n=>has(n,'contacto'));if(contact.length!==1)fail('institution_service_contact_missing');
  const webs=all(contact[0],n=>has(n,'web')).flatMap(n=>links(n,service.finalUrl));const pHost=new URL(p.url).hostname;
  if(!belongs(pHost,institution)||!webs.some(l=>new URL(l.url).hostname===pHost))fail('institution_program_not_endorsed');
  const program=await this.capture.capture(p.url),pd=tree(program.body),entry=all(pd,n=>has(n,'entry-content'))[0];if(!entry)fail('program_template_unsupported');
  const units=extractProgram(program),captures=[directory,service,program],urls=new Set([program.originalUrl,program.finalUrl]);
  for(const url of p.fuentesAdicionales||[]){
   const secondaryHost=new URL(url).hostname;const endorsedPortal=links(st,service.finalUrl).some(l=>new URL(l.url).hostname===secondaryHost&&/^(?:portal de comunicacion|comunicacion institucional|noticias institucionales)$/.test(normalizeText(l.text)));
   if(!belongs(secondaryHost,institution)||(!links(entry,program.finalUrl).some(l=>l.url===url)&&!endorsedPortal))fail('program_secondary_unanchored');
   const secondary=await this.capture.capture(url),sd=tree(secondary.body);
   if(!links(sd,secondary.finalUrl).some(l=>l.url===program.finalUrl))fail('program_secondary_no_reciprocal_link');
   units.push(extractConvocation(secondary,program.finalUrl));captures.push(secondary);urls.add(secondary.originalUrl);urls.add(secondary.finalUrl);
  }
  if(new Set(units.map(u=>u.unidadId)).size!==units.length)fail('program_unit_ambiguous');
  const programKey='program_'+hash([institution,program.finalUrl].join('\0')).slice(0,32);
  return {programKey,institution,units,captures,urls:[...urls],business,p};
 }
 candidate(bundle,u,requestId){
  const f=u.facts,p=bundle.p;const input={negocioId:bundle.business.id,titulo:f.titulo,descripcion:f.descripcion,fechaLocal:f.fechaLocal,horaLocal:f.horaLocal,timeZone:f.timeZone,city:f.city,lugar:f.lugar,provincia:f.provincia,pais:f.pais,tipo:f.tipo,precioInfo:f.precioInfo,sesionId:u.unidadId,origen:{proveedor:bundle.institution,id_externo:bundle.programKey,id_sesion:u.unidadId},fuentes:[{url:u.sourceUrl,sourceId:u.unidadId}],link:u.sourceUrl,verificationStatus:'capturado',programa:{...p,unidadId:u.unidadId}};
  if(f.fechaFinLocal)input.fechaFinLocal=f.fechaFinLocal;if(f.dateTimeEnd)input.dateTimeEnd=f.dateTimeEnd;if(requestId)input.requestId=requestId;
  return input;
 }
 async preview({negocioId,programa},principal){
  const b=await this.store.get('negocios',negocioId);if(!b)fail('business_not_found');
  const bundle=await this.load(programa,b);return {persistido:false,programKey:bundle.programKey,autoridad:{directorio:bundle.captures[0].finalUrl,institucion:bundle.institution,servicio:bundle.captures[1].finalUrl},unidades:bundle.units.map(u=>({unidadId:u.unidadId,carencias:u.carencias,admisibleDocumental:u.carencias.length===0,evento:u.carencias.length?null:this.candidate(bundle,u),titulo:u.facts.titulo,fechaLocal:u.facts.fechaLocal,horaLocal:u.facts.horaLocal,city:u.facts.city})),limites:['Solo directorio institucional y plantillas documentadas; no acredita otros formatos.','Municipio desconocido y horarios semanales se bloquean; no se sustituyen por revisión humana automática.']};
 }
 async evaluate(input,business){
  const b=await this.load(input.programa,business),u=b.units.find(u=>u.unidadId===input.programa.unidadId);if(!u)fail('program_unit_missing');
  // Extras must be evaluated even when the source unit is unrepresentable (range regression).
  if(input.fechaInicio!=null&&input.fechaInicio!==u.facts.fechaLocal)fail('source_discrepancy',{campos:['fechaInicio']});
  if(input.fechaFin!=null&&input.fechaFin!==u.facts.fechaFinLocal)fail('source_discrepancy',{campos:['fechaFin']});
  const expected=this.candidate(b,u,input.requestId),allow=new Set(Object.keys(expected)),unknown=[];
  // Each public field is either sourced, checked equivalent alias, or absent/unknown. Never spread caller data.
  for(const [k,v] of Object.entries(input)){
   if(k==='programa'||k==='requestId')continue;
   if(k==='fechaInicio'||k==='fechaFin')continue;
   if(!allow.has(k)){if(v!=null&&!(Array.isArray(v)&&v.length===0)&&v!==false)unknown.push(k);continue;}
   let same=equal(v,expected[k]);
   if(k==='titulo'||k==='descripcion'||k==='lugar')same=clean(v)===clean(expected[k]);
   if(k==='fuentes')same=Array.isArray(v)&&v.length===expected.fuentes.length&&v.every((s,i)=>s.url===expected.fuentes[i].url&&(s.sourceId==null||s.sourceId===expected.fuentes[i].sourceId)&&s.checkedAt==null);
   if(!same)unknown.push(k);
  }
  for(const k of ['negocioId','titulo','descripcion','city','fechaLocal','sesionId','origen','fuentes'])if(input[k]==null)unknown.push(k);
  if(unknown.length)fail('source_discrepancy',{campos:[...new Set(unknown)]});
  if(u.carencias.length)fail('source_insufficient',{carencias:u.carencias});
  const capturedAt=b.captures.find(c=>c.finalUrl===u.sourceUrl).capturedAt;
  // La procedencia institucional ya está acreditada: el servidor declara la fuente como oficial, no el agente.
  const event=canonicalInput({...expected,fuente_tipo:'oficial',fuente_nombre:String(b.business.data.nombre||b.business.data.name||'').trim().slice(0,80)||undefined,fuentes:expected.fuentes.map(s=>({...s,checkedAt:capturedAt}))});
  return {bundle:b,unit:u,event,input,semanticHash:fingerprint({policy:'institutional-program-v1',facts:u.facts,units:b.units.map(x=>({id:x.unidadId,facts:x.facts})).sort((a,b)=>a.id.localeCompare(b.id)),authority:{institution:b.institution,urls:b.captures.map(c=>c.finalUrl)}})};
 }
 async reconcile(evaluation,universe){
  const {bundle:b,unit:u}=evaluation,bindings=await this.all('amalia_program_sessions'),verifies=[{collection:'negocios',key:b.business.id,updateTime:b.business.updateTime}],witnesses=[];
  const snapshotCache=new Map();
  const verifySnapshots=async ids=>{if(!Array.isArray(ids)||!ids.length)fail('program_snapshot_corrupt');for(const key of ids){if(snapshotCache.has(key))continue;const row=await this.store.get('amalia_program_snapshots',key);if(!row)fail('program_snapshot_corrupt');validateSnapshot(row.data,key);snapshotCache.set(key,row);verifies.push({collection:'amalia_program_snapshots',key,updateTime:row.updateTime});}};
  const relatedBindings=bindings.filter(r=>r.data.programKey===b.programKey);
  for(const binding of relatedBindings){
   verifies.push({collection:'amalia_program_sessions',key:binding.id,updateTime:binding.updateTime});
   const now=b.units.find(n=>n.unidadId===binding.data.unitKey);
   if(binding.data.revoked===true||!now||binding.data.factsHash!==now.factsHash)fail('program_history_changed',{binding:binding.id});
  }
  const own=relatedBindings.find(r=>r.data.unitKey===u.unidadId);
  if(own&&!universe.docs.some(r=>r.id===own.data.eventId))fail('program_unit_reserved',{eventId:own.data.eventId});
  const safeOther=new Set();
  for(const row of universe.docs){
   const d=row.data;if(!sourceList(d).some(url=>b.urls.includes(url))&&d.programEvidence?.programKey!==b.programKey)continue;
   verifies.push({collection:'eventos',key:row.id,updateTime:row.updateTime});
   const binding=relatedBindings.find(r=>r.data.eventId===row.id);
   if(binding){await verifySnapshots(d.programEvidence?.snapshots);const boundUnit=b.units.find(n=>n.unidadId===binding.data.unitKey),expected=canonicalInput(this.candidate(b,boundUnit));const fields=['titulo','descripcion','city','lugar','provincia','pais','fechaLocal','horaLocal','timeZone','fechaFinLocal','dateTime','dateTimeEnd','tipo','aforo','precioEstado','precio','precioDetalle','categoria','categorias','image','assetId','sourceImageUrl','sustainableTip','publicTransport','cta'];if(fields.some(k=>!equal(d[k]??null,expected[k]??null)))fail('program_history_changed',{eventId:row.id});if(d.programEvidence?.unitKey!==binding.data.unitKey||d.programEvidence?.factsHash!==binding.data.factsHash)fail('program_history_changed',{eventId:row.id});if(binding.data.unitKey!==u.unidadId)safeOther.add(row.id);continue;}
   const resolution=d.programAncestorResolution;
   if(resolution?.programKey===b.programKey){
    await verifySnapshots(resolution.snapshots);
    if(d.retirado!==true||resolution.eventId!==row.id||resolution.previousVersion!==d.retiradoVersion||resolution.actor!==d.retiradoPor||resolution.kind!=='historical_group'||!resolution.actor||!resolution.proposalHash||!Array.isArray(resolution.coveredUnits)||resolution.coveredUnits.length<2)fail('program_resolution_invalid',{eventId:row.id});
    for(const covered of resolution.coveredUnits){const now=b.units.find(n=>n.unidadId===covered.unitKey);if(!now||now.factsHash!==covered.factsHash)fail('program_history_changed',{eventId:row.id});}
    if(resolution.coveredUnits.some(n=>n.unitKey===u.unidadId))fail('program_legacy_unit_conflict',{eventId:row.id});
    safeOther.add(row.id);witnesses.push({eventId:row.id,updateTime:row.updateTime,reason:'owner_resolved_retired_group',proposalHash:resolution.proposalHash});continue;
   }
   const matches=b.units.filter(n=>titleKey(n.facts.titulo)===titleKey(d.titulo||d.nombre||''));
   if(matches.length!==1)fail('program_history_ambiguous',{eventId:row.id});
   const matched=matches[0],f=matched.facts;
   if(!f.city||!f.fechaLocal||!f.horaLocal||timing(d)!==f.fechaLocal||(d.horaLocal||d.hora)!==f.horaLocal||normalizeText(d.city||d.ciudad||'')!==normalizeText(f.city))fail('program_history_changed',{eventId:row.id});
   if(witnesses.some(w=>w.unitKey===matched.unidadId)||relatedBindings.some(r=>r.data.unitKey===matched.unidadId))fail('program_history_ambiguous',{eventId:row.id});
   if(matched.unidadId===u.unidadId)fail('program_legacy_unit_conflict',{eventId:row.id});
   safeOther.add(row.id);witnesses.push({eventId:row.id,unitKey:matched.unidadId,updateTime:row.updateTime,reason:'legacy_exact_unit_not_modified'});
  }
  if(verifies.length>400)fail('program_history_limit');
  return {safeOther,verifies,witnesses,own,bindings:relatedBindings};
 }
 filter(scan,reconciliation){
  return {...scan,coincidencias:scan.coincidencias.filter(c=>!(reconciliation.safeOther.has(c.eventId)&&c.motivos.every(m=>['url_fuente','url_fuente_otra_sesion','source_id','source_id_otra_sesion'].includes(m))))};
 }
 async all(collection){const rows=[],seen=new Set();let cursor=null;for(;;){const page=await this.store.list(collection,{cursor,limit:500});if(!Array.isArray(page)||page.length>500)fail('incomplete_scan');for(const r of page){if(!r.id||seen.has(r.id))fail('incomplete_scan');seen.add(r.id);rows.push(r);if(rows.length>5000)fail('program_history_limit');}if(page.length<500)return rows;cursor=page.at(-1).id;}}
 async snapshots(b){
  const extras=[],verifies=[],refs=[];
  for(const capture of b.captures){const key='snapshot_'+capture.digest;validateSnapshot(capture,key);if(Buffer.byteLength(JSON.stringify(capture))>800000)fail('source_snapshot_too_large');const prior=await this.store.get('amalia_program_snapshots',key);if(prior){validateSnapshot(prior.data,key);if(prior.data.originalUrl!==capture.originalUrl||prior.data.finalUrl!==capture.finalUrl||prior.data.body!==capture.body)fail('program_snapshot_corrupt');verifies.push({collection:'amalia_program_snapshots',key,updateTime:prior.updateTime});}else extras.push({collection:'amalia_program_snapshots',key,data:capture});refs.push(key);}
  return {extras,verifies,refs};
 }
 async commitEvidence(ev,rec,eventId){
  const {bundle:b,unit:u}=ev,{extras,verifies,refs}=await this.snapshots(b);verifies.push(...rec.verifies);
  const bindingKey='binding_'+hash(b.programKey+'\0'+u.unidadId).slice(0,40);
  extras.push({collection:'amalia_program_sessions',key:bindingKey,data:{programKey:b.programKey,unitKey:u.unidadId,eventId,factsHash:u.factsHash,facts:u.facts,revoked:false,sourceUrl:u.sourceUrl,policy:'institutional-program-v1',createdAt:new Date().toISOString()}});
  return {verifies,extras,record:{programEvidence:{programKey:b.programKey,unitKey:u.unidadId,factsHash:u.factsHash,bindingId:bindingKey,snapshots:refs,authority:b.institution,policy:'institutional-program-v1',legacyWitnesses:rec.witnesses},carencias:[...(u.facts.aforo==null?['aforo_no_acreditado']:[]),'categoria_no_acreditada',...(u.facts.precioInfo.estado==='desconocido'?['precio_no_acreditado']:[])]}};
 }
 proposal(ev,scan,principal){return fingerprint({actor:principal.id,original:ev.input,evidence:ev.semanticHash,conflicts:scan.coincidencias});}
}
