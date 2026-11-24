import { buildGuardWrite } from './guardia_commit.mjs';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DomainError, fail, id } from './event-domain.mjs';
import { toFirestoreFields } from './event-record.mjs';

export function decodeValue(v) {
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  // La API REST omite en un GeoPoint las coordenadas que valen 0 (proto3): {} es (0, 0) y {longitude: 5} es (0, 5).
  if ('geoPointValue' in v) return {latitude:v.geoPointValue.latitude ?? 0,longitude:v.geoPointValue.longitude ?? 0};
  if ('referenceValue' in v) return v.referenceValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
export const decodeFields = fields => Object.fromEntries(Object.entries(fields || {}).map(([k,v])=>[k,decodeValue(v)]));
// Metadatos de evento que no afectan a duplicados: identidad canónica y, al fusionar fuentes, a qué fuente del registro pertenece (con su rastro).
const METADATOS_EVENTO=new Set(['agenteCanonico','fuenteId','fuenteIdAnterior','fuenteMovidaPor','fuenteMovidaEn','fuenteMovidaMotivo','updatedBy','updatedByPrincipal','retiradoPor','retiradoPorPrincipal','recuperadoPor','recuperadoPorPrincipal']);
export class FirestoreStore {
  constructor({project,key,credentialsFile,apiBase='https://firestore.googleapis.com/v1',fetchImpl=fetch}) { this.project=project;this.key=key;this.credentials=credentialsFile ? JSON.parse(readFileSync(credentialsFile,'utf8')) : null;this.apiBase=apiBase;this.fetch=fetchImpl;this.token=null;this.tokenUntil=0;this.prefix=`projects/${project}/databases/(default)/documents`; }
  async auth() {
    if (!this.credentials) return {};
    if (Date.now()<this.tokenUntil) return {authorization:`Bearer ${this.token}`};
    const c=this.credentials,now=Math.floor(Date.now()/1000),encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
    const body=`${encode({alg:'RS256',typ:'JWT'})}.${encode({iss:c.client_email,scope:'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
    const signature=createSign('RSA-SHA256').update(body).sign(c.private_key).toString('base64url');
    const r=await this.fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${body}.${signature}`}),signal:AbortSignal.timeout(12000)});
    if (!r.ok) fail('backend_auth_failed');const t=await r.json();this.token=t.access_token;this.tokenUntil=Date.now()+(t.expires_in-120)*1000;
    return {authorization:`Bearer ${this.token}`};
  }
  async request(path,options={}) {
    const u=new URL(`${this.apiBase}/${this.prefix}${path}`);if(this.key)u.searchParams.set('key',this.key);
    const r=await this.fetch(u,{...options,headers:{'content-type':'application/json',...await this.auth(),...options.headers},signal:AbortSignal.timeout(15000)});
    if(r.status===404){if((options.method||'GET')!=='GET')fail('firestore_http_404');return null;}
    if([409,412].includes(r.status))fail('version_conflict');
    if(!r.ok){const detail=await r.json().catch(()=>({}));if(['FAILED_PRECONDITION','ABORTED','ALREADY_EXISTS'].includes(detail.error?.status))fail('version_conflict');throw new DomainError(`firestore_http_${r.status}`,{operacion:(options.method||'GET')+' '+path.split('?')[0].replace(/\/[^/]+$/,'/…'),estadoFirestore:detail.error?.status||null,ayuda:r.status===403?'La cuenta de servicio no tiene permiso para esta operación en Firestore (p. ej. borrar documentos).':undefined});}
    return r.json();
  }
  async get(collection,key) { const d=await this.request(`/${collection}/${id(key)}`);return d?{id:key,data:decodeFields(d.fields),updateTime:d.updateTime}:null; }
  async list(collection,{business,cursor,limit=50,name,city,estado,endAt,requestId,eq}={}) {
    const filters=[];
    for(const [campo,valor] of Object.entries(eq||{})){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(campo))fail('invalid_field',{campo});filters.push({fieldFilter:{field:{fieldPath:campo},op:'EQUAL',value:{stringValue:String(valor)}}});}if(business)filters.push({fieldFilter:{field:{fieldPath:'negocioId'},op:'EQUAL',value:{stringValue:business}}});
    if(name)filters.push({fieldFilter:{field:{fieldPath:'nombre'},op:'EQUAL',value:{stringValue:name}}});
    if(requestId)filters.push({fieldFilter:{field:{fieldPath:'requestId'},op:'EQUAL',value:{stringValue:requestId}}});
    if(estado)filters.push({fieldFilter:{field:{fieldPath:'estado'},op:'EQUAL',value:{stringValue:estado}}});
    if(city)filters.push({fieldFilter:{field:{fieldPath:'city'},op:'EQUAL',value:{stringValue:city}}});
    const query={from:[{collectionId:collection}],orderBy:[{field:{fieldPath:'__name__'},direction:'ASCENDING'}],limit};
    if(filters.length)query.where=filters.length===1?filters[0]:{compositeFilter:{op:'AND',filters}};
    if(cursor)query.startAt={values:[{referenceValue:`${this.prefix}/${collection}/${id(cursor)}`}],before:false};
    if(endAt)query.endAt={values:[{referenceValue:`${this.prefix}/${collection}/${id(endAt)}`}],before:false};
    const rows=await this.request(':runQuery',{method:'POST',body:JSON.stringify({structuredQuery:query})});
    if(!Array.isArray(rows))fail('incomplete_scan');
    return rows.filter(r=>r.document).map(r=>({id:r.document.name.split('/').at(-1),data:decodeFields(r.document.fields),updateTime:r.document.updateTime}));
  }
  // Documentos cuyo campo de texto `campo` está en [desde, hasta] (índice de campo único, automático en Firestore). Pagina de 500 en 500 por (campo, id) hasta agotar; nunca recorre la colección.
  async queryRango(collection,campo,desde,hasta,{max=20000}={}) {
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(campo))fail('invalid_field',{campo});
    const out=[],f=(op,v)=>({fieldFilter:{field:{fieldPath:campo},op,value:{stringValue:v}}});
    let after=null;
    for(;;){
      const query={from:[{collectionId:collection}],where:{compositeFilter:{op:'AND',filters:[f('GREATER_THAN_OR_EQUAL',desde),f('LESS_THAN_OR_EQUAL',hasta)]}},orderBy:[{field:{fieldPath:campo},direction:'ASCENDING'},{field:{fieldPath:'__name__'},direction:'ASCENDING'}],limit:500};
      if(after)query.startAt={values:[{stringValue:after.valor},{referenceValue:`${this.prefix}/${collection}/${id(after.id)}`}],before:false};
      const rows=await this.request(':runQuery',{method:'POST',body:JSON.stringify({structuredQuery:query})});
      if(!Array.isArray(rows))fail('incomplete_scan');
      const page=rows.filter(r=>r.document).map(r=>({id:r.document.name.split('/').at(-1),data:decodeFields(r.document.fields),updateTime:r.document.updateTime}));
      out.push(...page);if(out.length>max)fail('incomplete_scan',{ayuda:'La ventana de fechas devuelve demasiados documentos.'});
      if(page.length<500)return out;
      const last=page.at(-1);after={valor:last.data[campo],id:last.id};
    }
  }
  // Lee una colección entera en paralelo: primero solo los ids (barato) y luego tramos acotados por id (startAt/endAt) para que no queden huecos aunque entren documentos mientras tanto.
  async listAll(collection,{max=Infinity,step=250,concurrency=2}={}) {
    const ids=[];let cursor=null;
    for(;;){
      const query={from:[{collectionId:collection}],select:{fields:[{fieldPath:'__name__'}]},orderBy:[{field:{fieldPath:'__name__'},direction:'ASCENDING'}],limit:5000};
      if(cursor)query.startAt={values:[{referenceValue:`${this.prefix}/${collection}/${id(cursor)}`}],before:false};
      const rows=await this.request(':runQuery',{method:'POST',body:JSON.stringify({structuredQuery:query})});
      if(!Array.isArray(rows))fail('incomplete_scan');
      const got=rows.filter(r=>r.document).map(r=>r.document.name.split('/').at(-1));
      ids.push(...got);if(ids.length>max)fail('catalog_limit_exceeded');
      if(got.length<5000)break;cursor=got.at(-1);
    }
    const ranges=[];for(let i=0;i<ids.length;i+=step)ranges.push({from:i===0?null:ids[i-1],to:i+step>=ids.length?null:ids[i+step-1]});
    const parts=new Array(ranges.length);let next=0;
    await Promise.all(Array.from({length:Math.min(concurrency,ranges.length)},async()=>{for(;;){const k=next++;if(k>=ranges.length)return;const r=ranges[k];parts[k]=await this.list(collection,{cursor:r.from,endAt:r.to||undefined,limit:step*2});if(parts[k].length>=step*2)fail('incomplete_scan');}}));
    const out=[],seen=new Set();for(const rows of parts)for(const row of rows){if(seen.has(row.id))fail('incomplete_scan');seen.add(row.id);out.push(row);}
    return out;
  }
  // Claves de sesión (sesiones_clave) en el MISMO commit que el evento. La cuenta de servicio NO puede borrar documentos (403): liberar una clave es una ACTUALIZACIÓN (estado:'liberada') con precondición de versión.
  // crear exige que no exista; actualizar exige el updateTime leído (nadie la tocó entretanto).
  clavesWrites(writes,claves,permitido=true) {
    if(!claves||!permitido)return;
    for(const c of claves.crear||[])writes.push({update:{name:`${this.prefix}/sesiones_clave/${id(c.id)}`,fields:toFirestoreFields(c.data)},currentDocument:{exists:false}});
    for(const c of claves.actualizar||[]){if(!c.updateTime)fail('clave_version_missing');writes.push({update:{name:`${this.prefix}/sesiones_clave/${id(c.id)}`,fields:toFirestoreFields(c.data)},currentDocument:{updateTime:c.updateTime}});}
  }
  // Varios documentos de `eventos` (con auditoría) y sus claves en UN solo commit atómico, con la guardia movida una vez. Cada item: {key,data,updateTime,updateFields,audit}.
  async writeMany(items,{guard,claves}={}) {
    if(!Array.isArray(items)||!items.length)fail('invalid_field',{campo:'items'});
    const writes=[],mask=fs=>({fieldPaths:fs.map(k=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)?k:'`'+k.replaceAll('\\','\\\\').replaceAll('`','\\`')+'`')});
    for(const it of items){
      writes.push({update:{name:`${this.prefix}/eventos/${id(it.key)}`,fields:toFirestoreFields(it.data)},updateMask:mask(it.updateFields),currentDocument:{updateTime:it.updateTime}});
      if(it.audit)writes.push({update:{name:`${this.prefix}/eventos/${id(it.key)}/revisiones/v${String(it.data.version).padStart(8,'0')}`,fields:toFirestoreFields(it.audit)},currentDocument:{exists:false}});
    }
    this.clavesWrites(writes,claves);
    if(writes.length>499)fail('program_commit_limit');
    writes.push(buildGuardWrite(this.prefix,guard||{}));
    const r=await this.request(':commit',{method:'POST',body:JSON.stringify({writes})});
    return {escritos:items.map(it=>it.key),resultados:r.writeResults?.length||0};
  }
  async write(collection,key,data,{updateTime,create=false,audit,request,reserve,updateFields,guard,verifies=[],extras=[],moveReserve=null,metadataOnly=false,claves=null}={}) {
    // Excepción acotada a la invariante «todo commit de eventos mueve la guardia»: metadatos de auditoría que no afectan a duplicados (solo agenteCanonico, sobre un documento existente).
    if(metadataOnly&&!(collection==='eventos'&&!create&&Array.isArray(updateFields)&&updateFields.length>0&&updateFields.every(f=>METADATOS_EVENTO.has(f))))fail('metadata_write_forbidden');
    if(collection==='eventos'&&create&&!guard?.updateTime)fail('admission_guard_required');
    const writes=[{update:{name:`${this.prefix}/${collection}/${id(key)}`,fields:toFirestoreFields(data)},currentDocument:create?{exists:false}:{updateTime}}];
    if(updateFields)writes[0].updateMask={fieldPaths:updateFields.map(k=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)?k:'`'+k.replaceAll('\\','\\\\').replaceAll('`','\\`')+'`')};
    if(audit)writes.push({update:{name:`${this.prefix}/${collection}/${id(key)}/revisiones/v${String(data.version).padStart(8,'0')}`,fields:toFirestoreFields(audit)},currentDocument:{exists:false}});
    if(request)writes.push({update:{name:`${this.prefix}/amalia_event_requests/${id(request.id)}`,fields:toFirestoreFields(request.data)},currentDocument:{exists:false}});
    if(reserve)writes.push({update:{name:`${this.prefix}/amalia_event_reservations/${id(reserve.id)}`,fields:toFirestoreFields({...reserve.data,estado:'activa'})},currentDocument:reserve.updateTime?{updateTime:reserve.updateTime}:{exists:false}});
    // La cuenta de servicio no puede borrar: la reserva vieja se LIBERA (estado:'liberada', con precondición de versión) y la nueva se crea o, si existía liberada, se retoma con su versión.
    if(moveReserve){
      if(moveReserve.fromRow&&!moveReserve.fromRow.updateTime)fail('reserva_version_missing');
      if(moveReserve.fromRow)writes.push({update:{name:`${this.prefix}/amalia_event_reservations/${id(moveReserve.from)}`,fields:toFirestoreFields({...moveReserve.fromRow.data,estado:'liberada',eventIdAnterior:moveReserve.fromRow.data.eventId??null,eventId:null,liberadaEn:new Date().toISOString()})},currentDocument:{updateTime:moveReserve.fromRow.updateTime}});
      writes.push({update:{name:`${this.prefix}/amalia_event_reservations/${id(moveReserve.to.id)}`,fields:toFirestoreFields({...moveReserve.to.data,estado:'activa'})},currentDocument:moveReserve.to.updateTime?{updateTime:moveReserve.to.updateTime}:{exists:false}});
    }
    this.clavesWrites(writes,claves,collection==='eventos');
    const uniqueVerifies=new Map();for(const v of verifies){const name=v.collection+'/'+v.key,prior=uniqueVerifies.get(name);if(prior&&prior.updateTime!==v.updateTime)fail('version_conflict');uniqueVerifies.set(name,v);}
    for(const v of uniqueVerifies.values()){if(!v.updateTime)fail('program_document_version_missing');writes.push({verify:`${this.prefix}/${id(v.collection)}/${id(v.key)}`,currentDocument:{updateTime:v.updateTime}});}
    for(const x of extras){if(!['amalia_program_snapshots','amalia_program_sessions'].includes(x.collection))fail('program_extra_write_forbidden');writes.push({update:{name:`${this.prefix}/${x.collection}/${id(x.key)}`,fields:toFirestoreFields(x.data)},currentDocument:{exists:false}});}
    if(writes.length>499)fail('program_commit_limit');
    if(collection==='eventos'&&!metadataOnly)writes.push(buildGuardWrite(this.prefix,guard||{}));
    const r=await this.request(':commit',{method:'POST',body:JSON.stringify({writes})});return {id:key,data,updateTime:r.writeResults[0].updateTime};
  }
  async revisions(key) {
    const r=await this.request(`/eventos/${id(key)}/revisiones?pageSize=100`);
    return (r?.documents || []).map(d=>decodeFields(d.fields));
  }
}