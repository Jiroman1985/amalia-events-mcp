import test from 'node:test';
import assert from 'node:assert/strict';
import {FirestoreStore} from '../firestore-store.mjs';
import {EventService} from '../event-service.mjs';
import {hash,canonicalInput,eventIdentity,fingerprint} from '../event-domain.mjs';
import {normalizeProvenance} from '../registro-provenance.mjs';
const host=process.env.FIRESTORE_EMULATOR_HOST;
const owner={id:'authenticated-editor',actions:['read','admit','review'],businesses:['*']};
const sourceId='fte_web_'+hash('editor.example/programacion').slice(0,24);
const input=()=>({negocioId:'b',titulo:'Concierto exclusivo ensayo',descripcion:'Solo prueba aislada local',city:'Málaga',fechaLocal:'2027-05-01',sesionId:'s1',fuentes:[{url:'https://www.editor.example/programacion/concierto',sourceId:'unchanged-external-id'}],requestId:'same-request'});
const source=()=>({id:sourceId,canal:'web',identificador:'editor.example/programacion',url:'https://editor.example/programacion',nombre_entidad:'Editor de ensayo',municipio:'Málaga',origen:'asistente',negocio_id:null,estado:'activa'});
const provenance=version=>({version:1,fuenteId:sourceId,fuenteVersion:version,canalFuente:'web',identificadorCanonico:'editor.example/programacion',urlPrimaria:input().fuentes[0].url,evidenciaEditorial:{responsable:'Revisor editorial',verificadoEn:'2026-11-06T15:00:00Z',relacion:'La sección oficial del editor enlaza esta actividad',urls:['https://editor.example/quienes'],observacion:'Comprobación editorial documentada para ensayo'},canalEntrada:{canal:'EMAIL',referencia:'mensaje-ensayo'}});
test('strict provenance rejects missing evidence, forged actor and unknown fields',()=>{
 const p=provenance('2026-11-06T15:00:00.123456Z');assert.equal(normalizeProvenance(p).fuenteVersion,p.fuenteVersion);
 assert.throws(()=>normalizeProvenance({...p,actorServidor:'forged'}));assert.throws(()=>normalizeProvenance({...p,evidenciaEditorial:{...p.evidenciaEditorial,urls:[]}}));
});
test('registry provenance against isolated real Firestore',{skip:!host,timeout:90000},async t=>{
 assert.equal(host,'127.0.0.1:8686');const project='demo-amalia-registry',base=`http://${host}/v1`,store=new FirestoreStore({project,apiBase:base});
 const media={};const service=()=>new EventService(store,media,{registryCutoff:'2026-11-01T00:00:00Z'});
 const reset=async()=>{await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});await store.write('negocios','b',{nombre:'ensayo'},{create:true});await store.write('amalia_catalog_guard','eventos',{epoch:0},{create:true});await store.write('registro_fuentes',sourceId,source(),{create:true});};
 const withP=async()=>({...input(),procedenciaRegistro:provenance((await store.get('registro_fuentes',sourceId)).updateTime)});
 const admit=async(s,data)=>{const p=await s.prepareAdmission(data,owner);return s.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:p.evento},owner);};
 await t.test('normal admission preserves identity/content hashes/sourceId and durable audit',async()=>{
  await reset();const s=service(),data=await withP(),plain=await s.prepareAdmission(input(),owner),p=await s.prepareAdmission(data,owner);
  assert.equal(p.eventId,plain.eventId);assert.notEqual(p.proposalHash,plain.proposalHash);assert.equal(p.evento.procedenciaRegistro.fuenteVersion,data.procedenciaRegistro.fuenteVersion);
  const r=await s.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:p.evento},owner);
  assert.equal(r.eventId,eventIdentity(canonicalInput(input())));assert.equal(r.creationFingerprint,fingerprint(canonicalInput(input())));assert.equal(r.fuentes[0].sourceId,'unchanged-external-id');assert.equal(r.procedenciaRegistro.actorServidor,owner.id);assert.equal(r.procedenciaRegistro.procedencia.canalEntrada.canal,'EMAIL');assert.equal(r.procedenciaRegistro.procedencia.canalFuente,'web');
  assert.equal((await store.revisions(r.eventId))[0].after.provenanceHash,r.provenanceHash);
  const again=await s.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:p.evento},owner);assert.equal(again.eventId,r.eventId);assert.equal(again.alreadyCreated,true);assert.equal((await store.list('eventos')).length,1);
  await assert.rejects(s.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:{...data,procedenciaRegistro:{...data.procedenciaRegistro,evidenciaEditorial:{...data.procedenciaRegistro.evidenciaEditorial,observacion:'changed'}}}},owner),/registro_provenance_conflict/);
 });
 await t.test('old request without provenance cannot gain attribution, nor new request evade event identity',async()=>{
  await reset();const s=service(),old=await admit(s,input()),data=await withP();const p=await s.prepareAdmission(data,owner);
  await assert.rejects(s.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:p.evento},owner),/registro_provenance_conflict/);
  await assert.rejects(admit(s,{...data,requestId:'new-request'}),/registro_provenance_conflict/);assert.equal((await store.get('eventos',old.eventId)).data.procedenciaRegistro,undefined);assert.equal((await store.list('eventos')).length,1);
 });
 await t.test('source changed between prepare and admit rejects with zero events',async()=>{
  await reset();const s=service(),p=await s.prepareAdmission(await withP(),owner),row=await store.get('registro_fuentes',sourceId);await store.write('registro_fuentes',sourceId,{...row.data,estado:'pausada'},{updateTime:row.updateTime});
  await assert.rejects(s.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:p.evento},owner),/registro_source_ineligible/);assert.equal((await store.list('eventos')).length,0);
 });
 await t.test('atomic source precondition rejects race inside commit',async()=>{
  await reset();let raced=false;const racing=new FirestoreStore({project,apiBase:base,fetchImpl:async(u,o)=>{if(!raced&&String(u).endsWith(':commit')&&JSON.parse(o.body).writes.some(w=>w.update?.name.includes('/eventos/'))){raced=true;const row=await store.get('registro_fuentes',sourceId);await store.write('registro_fuentes',sourceId,{...row.data,origen:'cliente',negocio_id:'n'},{updateTime:row.updateTime});}return fetch(u,o);}});
  const s=new EventService(racing,media,{registryCutoff:'2026-11-01T00:00:00Z'}),p=await s.prepareAdmission(await withP(),owner);
  await assert.rejects(s.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:p.evento},owner),/registro_source_ineligible/);assert.equal((await store.list('eventos')).length,0);assert.equal((await store.list('amalia_event_requests')).length,0);
 });
 await t.test('lost response after commit reconciles exact request without another event',async()=>{
  await reset();let lost=false;const uncertain=new FirestoreStore({project,apiBase:base,fetchImpl:async(u,o)=>{const r=await fetch(u,o);if(!lost&&String(u).endsWith(':commit')&&JSON.parse(o.body).writes.some(w=>w.update?.name.includes('/eventos/'))){lost=true;await r.text();throw Error('response_lost');}return r;}});
  const s=new EventService(uncertain,media,{registryCutoff:'2026-11-01T00:00:00Z'}),p=await s.prepareAdmission(await withP(),owner);await assert.rejects(s.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:p.evento},owner),/response_lost/);
  const r=await service().admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:p.evento},owner);assert.equal(r.alreadyCreated,true);assert.equal((await store.list('eventos')).length,1);const before=(await store.get('eventos',r.eventId)).updateTime;const receipt=await service().registryAdmissionReceipt({negocioId:'b',requestId:'same-request'},owner);assert.equal(receipt.eventId,r.eventId);assert.equal(receipt.evento.fechaCreacion,r.fechaCreacion);assert.equal((await store.get('eventos',r.eventId)).updateTime,before);
 });
 await t.test('scope/cutoff/evidence fail closed, capability self-read has no writes',async()=>{
  await reset();const s=service(),data=await withP(),limited={...owner,actions:['read','admit']};await assert.rejects(s.prepareAdmission(data,limited),/forbidden/);
  const cap=await s.registryCapabilities({},limited);assert.equal(cap.canReview,false);assert.equal(cap.principalId,limited.id);await assert.rejects(s.registryCapabilities({fuenteId:sourceId},limited),/forbidden/);
  await assert.rejects(new EventService(store,media,{registryCutoff:''}).prepareAdmission(data,owner),/registro_cutoff_unconfigured/);
  await assert.rejects(s.prepareAdmission({...data,procedenciaRegistro:{...data.procedenciaRegistro,urlPrimaria:'https://editor.example/programacion'}},owner),/registro_primary_mismatch/);
  assert.equal((await store.list('eventos')).length,0);
 });
});
