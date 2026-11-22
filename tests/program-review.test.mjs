import test from 'node:test';
import assert from 'node:assert/strict';
import {html,urls} from './program-fixtures.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {EventService} from '../event-service.mjs';
import {ProgramAdmission} from '../program-admission.mjs';
import {hash,canonicalInput,eventIdentity,record} from '../event-domain.mjs';

const host=process.env.FIRESTORE_EMULATOR_HOST;
if(host)assert.equal(host,'127.0.0.1:8686');
const actor={id:'independent-review',actions:['*'],businesses:['*']};
const program={url:urls.programa,directorioUrl:urls.directorio,enlaceInstitucionalUrl:urls.institucion,fuentesAdicionales:[urls.convocatoria]};
async function setup(){
 const project='demo-amalia-independent-review';
 assert.equal((await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'})).ok,true);
 const store=new FirestoreStore({project,apiBase:`http://${host}/v1`});
 await store.write('negocios','b',{estado:'activo',fuentesInformacion:{sitioWeb:'https://culturacientifica.usal.es'}},{create:true});
 await store.write('amalia_catalog_guard','eventos',{epoch:0,admissionPaused:false},{create:true});
 const capture={capture:async url=>{const k=Object.keys(urls).find(k=>urls[k]===url);assert.ok(k);const body=html[k],sha=hash(body),hops=[{url,body,rawBase64:Buffer.from(body).toString('base64'),sha256:sha,status:200,headers:{location:null}}];return{originalUrl:url,finalUrl:url,body,capturedAt:'2026-11-03T18:00:00.000Z',digest:hash(hops.map(h=>({url:h.url,status:h.status,sha256:h.sha256,location:h.headers.location}))),hops};}};
 const events=new EventService(store,{get:()=>{throw Error('unexpected media');}},{programs:new ProgramAdmission(store,{capture})});
 const preview=await events.prepareProgram({negocioId:'b',programa:program},actor);
 const candidate=part=>structuredClone(preview.unidades.find(u=>u.titulo.includes(part)).evento);
 const admit=async e=>{const p=await events.prepareAdmission(e,actor);assert.equal(p.admisible,true);return events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:e},actor);};
 return {store,events,candidate,admit};
}
test('revisión independiente: historia contradictoria y revocación atómica',{skip:!host,timeout:120000},async t=>{
 await t.test('legacy de otra unidad con hora/ciudad contradictoria bloquea y no se modifica',async()=>{
  for(const changes of [{horaLocal:'10:15'},{city:'Salamanca'}]){
   const f=await setup(),legacy=canonicalInput({...f.candidate('Cultivo'),...changes}),guard=await f.store.get('amalia_catalog_guard','eventos');
   await f.store.write('eventos','legacy-review',record(legacy,actor),{create:true,guard:{updateTime:guard.updateTime,epoch:guard.data.epoch}});
   const before=await f.store.get('eventos','legacy-review');
   await assert.rejects(f.events.prepareAdmission(f.candidate('Cooperación Antártica'),actor),/program_history_changed/);
   assert.deepEqual(await f.store.get('eventos','legacy-review'),before);
   assert.equal((await f.store.list('eventos')).length,1);
  }
 });
 await t.test('mutación de campos reales sin cambiar evidencia no puede certificar otra unidad',async()=>{
  const f=await setup(),first=await f.admit(f.candidate('Cultivo')),before=await f.store.get('eventos',first.eventId);
  await f.store.write('eventos',first.eventId,{horaLocal:'10:15'},{updateTime:before.updateTime,updateFields:['horaLocal']});
  const mutated=await f.store.get('eventos',first.eventId);
  await assert.rejects(f.events.prepareAdmission(f.candidate('Cooperación Antártica'),actor),/program_history_changed/);
  assert.deepEqual(await f.store.get('eventos',first.eventId),mutated);
  assert.equal((await f.store.list('eventos')).length,1);
 });
 await t.test('revocación de binding entre lectura y commit impide ficha y reserva nuevas',async()=>{
  const f=await setup();await f.admit(f.candidate('Cultivo'));
  const e=f.candidate('Cooperación Antártica'),p=await f.events.prepareAdmission(e,actor),original=f.store.write.bind(f.store);
  let intercepted=false;
  f.store.write=async(c,k,d,opts)=>{
   if(c==='eventos'&&opts.create&&!intercepted){
    intercepted=true;
    const [binding]=await f.store.list('amalia_program_sessions');
    await original('amalia_program_sessions',binding.id,{revoked:true},{updateTime:binding.updateTime,updateFields:['revoked']});
   }
   return original(c,k,d,opts);
  };
  await assert.rejects(f.events.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:e},actor),/program_history_changed/);
  assert.equal(intercepted,true);
  assert.equal(await f.store.get('eventos',eventIdentity(canonicalInput(e))),null);
  assert.equal((await f.store.list('eventos')).length,1);
  assert.equal((await f.store.list('amalia_program_sessions')).length,1);
  assert.equal((await f.store.list('amalia_event_reservations')).length,1);
 });
 await t.test('snapshot existente alterado no puede reutilizarse como evidencia recuperable',async()=>{
  const f=await setup(),original=f.candidate('Cultivo'),first=await f.admit(original);
  const replay=await f.events.prepareAdmission(original,actor);
  const saved=await f.store.get('eventos',first.eventId);
  const key=saved.data.programEvidence.snapshots[0],snapshot=await f.store.get('amalia_program_snapshots',key);
  const hops=structuredClone(snapshot.data.hops);hops[0].rawBase64=Buffer.from('alteración fuera de banda').toString('base64');
  await f.store.write('amalia_program_snapshots',key,{hops},{updateTime:snapshot.updateTime,updateFields:['hops']});
  const e=f.candidate('Cooperación Antártica');
  await assert.rejects(f.events.prepareAdmission(e,actor),/program_snapshot_corrupt/);
  await assert.rejects(f.events.admitCandidate({accion:'admit',proposalHash:replay.proposalHash,evento:original},actor),/program_snapshot_corrupt/);
  assert.equal((await f.store.list('eventos')).length,1);
 });
});
