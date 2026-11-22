import test from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreStore } from '../firestore-store.mjs';
import { EventService } from '../event-service.mjs';
import { canonicalInput,eventIdentity,originKey } from '../event-domain.mjs';
const host=process.env.FIRESTORE_EMULATOR_HOST;
if(host)assert.equal(host,'127.0.0.1:8686');
const owner={id:'owner-fixture',actions:['*'],businesses:['*']},ingestor={id:'ingestor',actions:['read','create'],businesses:['*']};
const input=(over={})=>({negocioId:'b',titulo:'Concierto para ensayo',descripcion:'Evento de prueba exclusivamente local.',city:'Málaga',fechaLocal:'2027-05-01',sesionId:'s1',fuentes:[{url:'https://example.org/concierto'}],...over});
const media={persist:async()=>{throw Error('unexpected side effect')},get:()=>{throw Error('no asset in this fixture')}};
test('direct create is closed even for the owner',async()=>{
 const events=new EventService({get:()=>{throw Error('unexpected read')}},media);
 await assert.rejects(events.create(input(),owner),/direct_creation_disabled/);
});
test('the store cannot create an event without an admission guard',async()=>{
 const store=new FirestoreStore({project:'fixture',fetchImpl:async()=>{throw Error('unexpected transport')}});
 await assert.rejects(store.write('eventos','e',{version:1},{create:true}),/admission_guard_required/);
});
test('admission against real local Firestore', {skip:!host,timeout:90000},async t=>{
 const project='demo-amalia-mcp',base=`http://${host}/v1`,store=new FirestoreStore({project,apiBase:base}),events=new EventService(store,media);
 const reset=async()=>{
  const r=await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});assert.equal(r.ok,true);
  await store.write('negocios','b',{nombre:'Negocio de ensayo'},{create:true});
  await store.write('amalia_catalog_guard','eventos',{epoch:0,bumpAt:'init'},{create:true});
 };
 const admit=async data=>{const p=await events.prepareAdmission(data,owner);return events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:data},owner)};
 await t.test('prepare is read-only and does not change guard or candidate collections',async()=>{
  await reset();const before=await store.get('amalia_catalog_guard','eventos');
  const p=await events.prepareAdmission(input(),owner);assert.equal(p.persistido,false);assert.equal(p.admisible,true);
  assert.equal((await store.get('amalia_catalog_guard','eventos')).updateTime,before.updateTime);
  assert.equal((await store.list('eventos')).length,0);assert.equal((await store.list('candidatos_eventos')).length,0);
 });
 await t.test('the control document pauses admission without changing publication',async()=>{
  await reset();const current=await store.get('amalia_catalog_guard','eventos');
  await store.write('amalia_catalog_guard','eventos',{...current.data,admissionPaused:true},{updateTime:current.updateTime});
  const p=await events.prepareAdmission(input(),owner);assert.equal(p.admisible,false);assert.equal(p.admissionPaused,true);
  await assert.rejects(events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:input()},owner),/admission_paused/);
  assert.equal((await store.list('eventos')).length,0);
 });
 await t.test('an existing create permission does not silently become admit',async()=>{
  await reset();const p=await events.prepareAdmission(input(),ingestor);
  await assert.rejects(events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:input()},ingestor),/forbidden/);
  assert.equal((await store.list('eventos')).length,0);
 });
 await t.test('explicit action and exact proposal hash are required',async()=>{
  await reset();const p=await events.prepareAdmission(input(),owner);
  await assert.rejects(events.admitCandidate({accion:'create',proposalHash:p.proposalHash,evento:input()},owner),/explicit_admission_required/);
  await assert.rejects(events.admitCandidate({accion:'admit',proposalHash:'0'.repeat(64),evento:input()},owner),/proposal_changed/);
  await assert.rejects(events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:input({descripcion:'Changed proposal data'})},owner),/proposal_changed/);
  assert.equal((await store.list('eventos')).length,0);
 });
 await t.test('another principal cannot reuse the original proposal hash',async()=>{
  await reset();const p=await events.prepareAdmission(input(),owner);
  await assert.rejects(events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:input()},{...owner,id:'another-owner'}),/proposal_changed/);
 });
 await t.test('three failed guard preconditions exhaust retries without blind write',async()=>{
  await reset();let commits=0;
  const blocked=new FirestoreStore({project,apiBase:base,fetchImpl:async(url,options)=>{
   if(options?.method==='POST' && String(url).endsWith(':commit')) {commits++;return new Response(JSON.stringify({error:{status:'FAILED_PRECONDITION'}}),{status:400});}
   return fetch(url,options);
  }});
  const service=new EventService(blocked,media),p=await service.prepareAdmission(input(),owner);
  await assert.rejects(service.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:input()},owner),/admission_contended/);
  assert.equal(commits,3);assert.equal((await store.list('eventos')).length,0);
 });
 await t.test('admission creates captured event, reservation, request, audit and guard together',async()=>{
  await reset();const data=input({requestId:'retry',origen:{proveedor:'fuente',id_externo:'evento-1',id_sesion:'s1'}}),e=await admit(data);
  assert.equal(e.created,true);assert.equal(e.verificationStatus,'capturado');assert.equal((await store.get('amalia_catalog_guard','eventos')).data.epoch,1);
  assert.equal((await store.get('amalia_event_reservations',originKey(data.origen))).data.eventId,e.eventId);
  assert.equal((await store.revisions(e.eventId)).length,1);assert.equal((await store.list('amalia_event_requests')).length,1);
  const again=await admit(data);assert.equal(again.alreadyCreated,true);assert.equal((await store.get('amalia_catalog_guard','eventos')).data.epoch,1);
 });
 await t.test('the returned evento payload preserves explicit free pricing on admission',async()=>{
  await reset();const p=await events.prepareAdmission(input({precioInfo:{estado:'gratis'}}),owner);
  const e=await events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:p.evento},owner);
  assert.equal(e.precio,0);assert.equal(e.precioEstado,'gratis');assert.equal(e.verificationStatus,'capturado');
 });
 await t.test('a competing legacy record invalidates a previously clean proposal',async()=>{
  await reset();const p=await events.prepareAdmission(input(),owner),guard=await store.get('amalia_catalog_guard','eventos');
  await store.write('eventos','legacy',{nombre:'Concierto para ensayo',ciudad:'Málaga',fecha_inicio:'2027-05-01'},{create:true,guard:{updateTime:guard.updateTime,epoch:guard.data.epoch}});
  await assert.rejects(events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:input()},owner),/duplicate_event_conflict/);
  assert.equal((await store.list('eventos')).length,1);
 });
 await t.test('two sources racing on the same title/date/city admit only once',async()=>{
  await reset();const a=input({sesionId:'a',fuentes:[{url:'https://a.example.org/e'}]}),b=input({sesionId:'b',fuentes:[{url:'https://b.example.org/e'}]});
  const [p,q]=await Promise.all([events.prepareAdmission(a,owner),events.prepareAdmission(b,owner)]);
  const results=await Promise.allSettled([events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:a},owner),events.admitCandidate({accion:'admit',proposalHash:q.proposalHash,evento:b},owner)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await store.list('eventos')).length,1);
 });
 await t.test('verified admission and raw image download are forbidden',async()=>{
  await reset();await assert.rejects(events.prepareAdmission(input({verificationStatus:'verificado'}),owner),/admission_requires_capturado/);
  await assert.rejects(events.prepareAdmission(input({image:'https://example.org/poster.jpg'}),owner),/image_requires_saved_asset/);
 });
 await t.test('identity edits are locked; descriptions can be corrected with a guard bump',async()=>{
  await reset();const e=await admit(input()),guard=await store.get('amalia_catalog_guard','eventos');
  await assert.rejects(events.update({eventId:e.eventId,negocioId:'b',expectedVersion:1,changes:{fechaLocal:'2027-05-02'},reason:'change date'},owner),/immutable_event_identity/);
  await assert.rejects(events.update({eventId:e.eventId,negocioId:'b',expectedVersion:1,changes:{temporalidad:{tipo:'sesiones',sesiones:[{fecha_local:'2027-06-01'}]}},reason:'indirect identity change'},owner),/immutable_event_identity/);
  await events.update({eventId:e.eventId,negocioId:'b',expectedVersion:1,changes:{descripcion:'Descripción corregida'},reason:'source correction'},owner);
  assert.notEqual((await store.get('amalia_catalog_guard','eventos')).updateTime,guard.updateTime);
 });
 await t.test('orphan origin reservation survives removal and blocks readmission',async()=>{
  await reset();const data=input({origen:{proveedor:'fuente',id_externo:'evento-1',id_sesion:'s1'}}),e=await admit(data);
  const r=await fetch(`${base}/${store.prefix}/eventos/${e.eventId}`,{method:'DELETE'});assert.equal(r.ok,true);
  const p=await events.prepareAdmission(data,owner);assert.equal(p.admisible,false);assert.equal(p.coincidencias[0].motivos[0],'reserva_huerfana');
  await assert.rejects(events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:data},owner),/duplicate_event_conflict/);
 });
});

test('admit-only ingestor can keep incomplete candidates private',async()=>{
 const docs=new Map(),store={get:async(c,k)=>docs.get(c+'/'+k)||null,write:async(c,k,data)=>{assert.equal(c,'candidatos_eventos');docs.set(c+'/'+k,{data});}};
 const service=new EventService(store,media),principal={id:'ingestor-admit',actions:['read','admit'],businesses:['*']};
 const result=await service.saveCandidate({titulo:'Información incompleta',carencias:['fecha'],fuentes:[{url:'https://example.org/c'}]},principal);
 assert.equal(result.created,true);assert.equal(result.coleccion,'candidatos_eventos');assert.equal(docs.size,1);
 await assert.rejects(service.create(input(),principal),/direct_creation_disabled/);
 await assert.rejects(service.saveCandidate({titulo:'Información incompleta',carencias:['fecha'],fuentes:[{url:'https://example.org/c'}]},{...principal,actions:['read']}),/forbidden/);
});
