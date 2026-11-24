import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError,publishableEvent } from '../event-domain.mjs';
import { HistoricalFixtureService as EventService } from './helpers/historical-fixtures.mjs';
import { MediaStore } from '../media-store.mjs';
import { Editorial } from '../editorial.mjs';
import { KalmaExport } from '../kalma-export.mjs';
import { createApp,VERSION } from '../server-v2.mjs';
import { hash } from '../event-domain.mjs';

const owner={id:'conchi-owner',actions:['*'],businesses:['*']};
const editorA={id:'editor-a',actions:['read','create','edit'],businesses:['bizA']};
const retirerA={id:'retirer-a',actions:['read','edit','retire','restore'],businesses:['bizA']};
const retirerB={id:'retirer-b',actions:['read','edit','retire','restore'],businesses:['bizB']};
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mNQAAAAASUVORK5CYII=';

/** Imita Firestore: updateTime por documento, precondiciones y, con máscara, fusión parcial (un campo de la máscara ausente en `data` se borra). */
class MemoryStore {
 constructor(){this.rows=new Map([['negocios/bizA',{data:{nombre:'A'},updateTime:'1'}],['negocios/bizB',{data:{nombre:'B'},updateTime:'2'}]]);this.audit=new Map();this.seq=2;this.writes=[];}
 async get(c,id){const r=this.rows.get(c+'/'+id);return r?{id,...structuredClone(r)}:null;}
 async list(c,{business}={}){return [...this.rows].filter(([k,r])=>k.startsWith(c+'/')&&(!business||r.data.negocioId===business)).map(([k,r])=>({id:k.split('/').at(-1),...structuredClone(r)}));}
 async write(c,id,data,{updateTime,create,audit,request,updateFields}={}){
  const key=c+'/'+id,cur=this.rows.get(key);
  if((create&&cur)||(!create&&cur?.updateTime!==updateTime)||(request&&this.rows.has('amalia_event_requests/'+request.id)))throw new DomainError('version_conflict');
  let next=structuredClone(data);
  if(updateFields&&cur){next=structuredClone(cur.data);for(const f of updateFields){if(f in data)next[f]=structuredClone(data[f]);else delete next[f];}}
  const r={data:next,updateTime:String(++this.seq)};this.rows.set(key,r);this.writes.push({c,id,fields:updateFields||null});
  if(audit)this.audit.set(id,[...(this.audit.get(id)||[]),structuredClone(audit)]);
  if(request)this.rows.set('amalia_event_requests/'+request.id,{data:request.data,updateTime:String(this.seq)});
  return {id,...r};
 }
 async revisions(id){return this.audit.get(id)||[];}
 touch(c,id){const r=this.rows.get(c+'/'+id);r.updateTime=String(++this.seq);}   // otra escritura concurrente que no cambia la versión
}
const input=(o={})=>({negocioId:'bizA',titulo:'Concierto de ensayo',descripcion:'Evento de ensayo.',city:'Málaga',fechaLocal:'2099-05-10',horaLocal:null,timeZone:'Europe/Madrid',sesionId:'ensayo-1',fuentes:[{url:'https://example.org/e',checkedAt:'2026-10-28T07:00:00Z'}],prueba:true,verificationStatus:'capturado',...o});
async function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'amalia-retire-')),db=new DatabaseSync(':memory:'),store=new MemoryStore();
 const media=new MediaStore({directory,db,publicBase:'https://example.org/amalia-events',downloader:async()=>Buffer.from(PNG,'base64')}),events=new EventService(store,media);
 const accounts=[{id:'ig1',channel:'instagram',username:'amaliaexperience',confirmed:true,businesses:['*']}];
 const editorial=new Editorial({db,events,media,accounts,publicBase:'https://example.org',paused:false});
 const kalma=new KalmaExport({events,media,editorial,key:'ab'.repeat(32),config:{businessId:'kalma-biz',profile:'p',instagram:'amaliaexperience'}});
 return {directory,db,store,media,events,editorial,kalma,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const preview=(f,e,p=owner)=>f.events.retirePreview({eventId:e.eventId,negocioId:'bizA'},p);
const retire=async(f,e,extra={},p=owner)=>{const v=await preview(f,e,p);return f.events.retire({eventId:e.eventId,negocioId:'bizA',expectedVersion:v.versionActual,codigoConfirmacion:v.codigoConfirmacion,motivo:'Duplicado de otro evento',...extra},p);};

test('la vista previa identifica el evento y no cambia nada',async()=>{
 const f=await fixture();try{
  const e=await f.events.create(input(),owner),before=structuredClone(f.store.rows.get('eventos/'+e.eventId)),writes=f.store.writes.length;
  const v=await preview(f,e);
  assert.equal(v.evento.eventId,e.eventId);assert.equal(v.evento.negocioId,'bizA');assert.equal(v.evento.titulo,'Concierto de ensayo');assert.equal(v.evento.fechaLocal,'2099-05-10');assert.equal(v.evento.prueba,true);assert.equal(v.versionActual,1);assert.match(v.codigoConfirmacion,/^[a-f0-9]{12}$/);
  assert.deepEqual(f.store.rows.get('eventos/'+e.eventId),before);assert.equal(f.store.writes.length,writes);
 }finally{f.close();}});

test('retirar exige motivo, versión vigente y el código de la vista previa',async()=>{
 const f=await fixture();try{
  const e=await f.events.create(input(),owner),v=await preview(f,e),base={eventId:e.eventId,negocioId:'bizA',expectedVersion:1,codigoConfirmacion:v.codigoConfirmacion,motivo:'Duplicado'};
  await assert.rejects(f.events.retire({...base,motivo:'  '},owner),/reason_required/);
  await assert.rejects(f.events.retire({...base,motivo:'x'.repeat(501)},owner),/reason_required/);
  await assert.rejects(f.events.retire({...base,expectedVersion:0},owner),/version_conflict/);
  await assert.rejects(f.events.retire({...base,codigoConfirmacion:'0'.repeat(12)},owner),/confirmation_mismatch/);
  await assert.rejects(f.events.retire({...base,codigoConfirmacion:undefined},owner),/confirmation_mismatch/);
  assert.equal(f.store.rows.get('eventos/'+e.eventId).data.retirado,undefined);
 }finally{f.close();}});

test('retirar es lógico: conserva el documento, registra quién, cuándo y por qué, y lo oculta',async()=>{
 const f=await fixture();try{
  const e=await f.events.create(input({estadoLegacy:undefined}),owner),antes=f.store.rows.get('eventos/'+e.eventId).data;
  const done=await retire(f,e,{motivo:'  Publicado por error  '});
  const doc=f.store.rows.get('eventos/'+e.eventId);assert.ok(doc,'el documento sigue existiendo');
  assert.equal(doc.data.retirado,true);assert.equal(doc.data.retiradoPor,'conchi');assert.equal(doc.data.retiradoPorPrincipal,'conchi-owner');assert.equal(doc.data.retiradoMotivo,'Publicado por error');assert.ok(Date.parse(doc.data.retiradoEn));
  assert.equal(doc.data.activa,false);assert.equal(doc.data.estado,'retirado');assert.equal(doc.data.version,2);assert.equal(doc.data.retiradoVersion,1);
  assert.equal(doc.data.titulo,antes.titulo);assert.deepEqual(doc.data.fuentes,antes.fuentes);assert.equal(doc.data.negocioId,'bizA');   // el resto de campos intacto (escritura parcial)
  assert.equal(done.version,2);
  assert.deepEqual(f.store.writes.at(-1).fields.includes('titulo'),false);
  const revs=await f.events.history(e.eventId,'bizA',owner);assert.deepEqual(revs.revisiones.map(r=>r.action),['created','retired']);assert.equal(revs.revisiones[1].actor,'conchi');assert.equal(revs.revisiones[1].actorPrincipal,'conchi-owner');assert.equal(revs.revisiones[1].reason,'Publicado por error');
  assert.equal((await f.events.get(e.eventId,'bizA',owner)).retirado,true);               // sigue consultable para poder recuperarlo
  assert.deepEqual((await f.events.list({negocioId:'bizA'},owner)).eventos,[]);            // oculto en el listado
  assert.equal((await f.events.list({negocioId:'bizA',incluirRetirados:true},owner)).eventos.length,1);
  await assert.rejects(f.events.update({eventId:e.eventId,negocioId:'bizA',expectedVersion:2,changes:{descripcion:'otra'},reason:'x y z'},owner),/event_retired/);
  await assert.rejects(f.events.create(input(),owner),/event_retired/);                    // no se resucita por duplicado
  assert.throws(()=>publishableEvent(doc.data),/event_retired/);
  await assert.rejects(f.kalma.prepare({negocioId:'bizA',eventId:e.eventId},owner),/event_retired/);
  await assert.rejects(preview(f,e),/already_retired/);
 }finally{f.close();}});

test('un cambio concurrente entre la vista previa y la ejecución se rechaza',async()=>{
 const f=await fixture();try{
  const e=await f.events.create(input(),owner),v=await preview(f,e);
  await f.events.update({eventId:e.eventId,negocioId:'bizA',expectedVersion:1,changes:{descripcion:'Cambiada por otra persona.'},reason:'cambio concurrente'},owner);
  await assert.rejects(f.events.retire({eventId:e.eventId,negocioId:'bizA',expectedVersion:1,codigoConfirmacion:v.codigoConfirmacion,motivo:'Duplicado'},owner),/version_conflict/);
  const v2=await preview(f,e);f.store.touch('eventos',e.eventId);   // alguien escribe sin cambiar la versión
  await assert.rejects(f.events.retire({eventId:e.eventId,negocioId:'bizA',expectedVersion:2,codigoConfirmacion:v2.codigoConfirmacion,motivo:'Duplicado'},owner),/confirmation_mismatch/);
  assert.equal(f.store.rows.get('eventos/'+e.eventId).data.retirado,undefined);
 }finally{f.close();}});

test('la precondición del almacén también protege una escritura simultánea',async()=>{
 const f=await fixture();try{
  const e=await f.events.create(input(),owner),v=await preview(f,e),real=f.store.write.bind(f.store);
  f.store.write=async(...a)=>{f.store.touch('eventos',e.eventId);return real(...a);};   // la otra escritura llega justo antes de la nuestra
  await assert.rejects(f.events.retire({eventId:e.eventId,negocioId:'bizA',expectedVersion:1,codigoConfirmacion:v.codigoConfirmacion,motivo:'Duplicado'},owner),/version_conflict/);
  assert.equal(f.store.rows.get('eventos/'+e.eventId).data.retirado,undefined);
 }finally{f.close();}});

test('recuperar restaura el estado anterior, conserva la historia y exige versión y motivo',async()=>{
 const f=await fixture();try{
  const e=await f.events.create(input(),owner);
  f.store.rows.get('eventos/'+e.eventId).data.estado='approved';f.store.rows.get('eventos/'+e.eventId).data.activa=true;   // un evento ya visible para el buscador
  const done=await retire(f,e);assert.equal(f.store.rows.get('eventos/'+e.eventId).data.estadoAnterior,'approved');
  await assert.rejects(f.events.restore({eventId:e.eventId,negocioId:'bizA',expectedVersion:1,motivo:'Error'},owner),/version_conflict/);
  await assert.rejects(f.events.restore({eventId:e.eventId,negocioId:'bizA',expectedVersion:done.version,motivo:''},owner),/reason_required/);
  const back=await f.events.restore({eventId:e.eventId,negocioId:'bizA',expectedVersion:done.version,motivo:'Se retiró por error'},owner);
  const d=f.store.rows.get('eventos/'+e.eventId).data;
  assert.equal(d.retirado,false);assert.equal(d.estado,'approved');assert.equal(d.activa,true);assert.equal(d.version,3);assert.equal(d.recuperadoPor,'conchi');assert.equal(d.recuperadoMotivo,'Se retiró por error');assert.equal(d.retiradoPor,null);assert.equal(back.version,3);
  assert.equal((await f.events.list({negocioId:'bizA'},owner)).eventos.length,1);
  assert.deepEqual((await f.events.history(e.eventId,'bizA',owner)).revisiones.map(r=>r.action),['created','retired','restored']);
  await assert.rejects(f.events.restore({eventId:e.eventId,negocioId:'bizA',expectedVersion:3,motivo:'Otra vez'},owner),/not_retired/);
  await f.events.update({eventId:e.eventId,negocioId:'bizA',expectedVersion:3,changes:{descripcion:'Ya editable otra vez.'},reason:'edición tras recuperar'},owner);
 }finally{f.close();}});

test('un evento sin estado ni activa originales los recupera ausentes',async()=>{
 const f=await fixture();try{
  const e=await f.events.create(input(),owner),done=await retire(f,e);
  await f.events.restore({eventId:e.eventId,negocioId:'bizA',expectedVersion:done.version,motivo:'Error al retirar'},owner);
  const d=f.store.rows.get('eventos/'+e.eventId).data;assert.equal('estado' in d,false);assert.equal('activa' in d,false);
 }finally{f.close();}});

test('negocio incorrecto, evento inexistente y permisos',async()=>{
 const f=await fixture();try{
  const e=await f.events.create(input(),owner);
  // otro negocio nunca puede consultar, editar, retirar ni recuperar el evento de A
  const other=(p,fn)=>assert.rejects(fn(p),/business_forbidden/);
  await other(owner,p=>f.events.retirePreview({eventId:e.eventId,negocioId:'bizB'},p));
  await other(owner,p=>f.events.retire({eventId:e.eventId,negocioId:'bizB',expectedVersion:1,codigoConfirmacion:'0'.repeat(12),motivo:'Prueba'},p));
  await other(owner,p=>f.events.restore({eventId:e.eventId,negocioId:'bizB',expectedVersion:1,motivo:'Prueba'},p));
  await other(owner,p=>f.events.update({eventId:e.eventId,negocioId:'bizB',expectedVersion:1,changes:{descripcion:'x y'},reason:'x y z'},p));
  await other(owner,p=>f.events.get(e.eventId,'bizB',p));
  await other(retirerB,p=>f.events.retirePreview({eventId:e.eventId,negocioId:'bizA'},p));
  await other(retirerB,p=>f.events.restore({eventId:e.eventId,negocioId:'bizA',expectedVersion:1,motivo:'Prueba'},p));
  // inexistente
  await assert.rejects(f.events.retirePreview({eventId:'ev_nope',negocioId:'bizA'},owner),/event_not_found/);
  await assert.rejects(f.events.restore({eventId:'ev_nope',negocioId:'bizA',expectedVersion:1,motivo:'Prueba'},owner),/event_not_found/);
  // sin permiso de retirar / recuperar
  await assert.rejects(f.events.retirePreview({eventId:e.eventId,negocioId:'bizA'},editorA),/forbidden/);
  await assert.rejects(f.events.restore({eventId:e.eventId,negocioId:'bizA',expectedVersion:1,motivo:'Prueba'},editorA),/forbidden/);
  // quien sí tiene permiso en su negocio puede
  const done=await retire(f,e,{},retirerA);assert.equal(done.retiradoPor,'retirer-a');
  await f.events.restore({eventId:e.eventId,negocioId:'bizA',expectedVersion:done.version,motivo:'Error al retirar'},retirerA);
  // un documento sin negocioId (evento antiguo) no se puede retirar desde el MCP
  f.store.rows.set('eventos/legacy1',{data:{nombre:'Antiguo',city:'Málaga'},updateTime:'9'});
  await assert.rejects(f.events.retirePreview({eventId:'legacy1',negocioId:'bizA'},owner),/business_forbidden/);
 }finally{f.close();}});

async function rpc(base,token,name,args){
 const r=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
 const body=await r.json();return {error:body.result.isError,data:body.result.structuredContent.result};
}
test('herramientas MCP: vista previa, confirmación, piezas en Kalma, recuperación y buscador público',async()=>{
 const f=await fixture();
 const ctx={store:f.store,events:f.events,media:f.media,editorial:f.editorial,kalma:f.kalma,publicBase:'https://example.org'};
 const registry=[{id:'conchi-owner',tokenHash:hash('token-de-ensayo-no-real'),actions:['*'],businesses:['*']},{id:'editor-a',tokenHash:hash('token-editor-ensayo'),actions:['read','create','edit'],businesses:['bizA']}];
 const app=createApp(ctx,registry);await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port,T='token-de-ensayo-no-real';
 try{
  assert.equal(VERSION,'2.25.8');
  const e=await f.events.create(input(),owner);
  // búsqueda pública: un evento verificado y visible aparece; retirado, no
  const doc=f.store.rows.get('eventos/'+e.eventId);doc.data.verificationStatus='verificado';doc.data.prueba=false;doc.data.fuentes=[{url:'https://example.org/e',checkedAt:'2026-10-28T07:00:00Z'}];
  const publicReader={id:'reader',tokenHash:hash('lector-publico-ensayo'),actions:['read_public'],businesses:[]};registry.push(publicReader);
  const found=async()=>(await rpc(base,'lector-publico-ensayo','buscar_eventos_publicos',{city:'Málaga'})).data.eventos.map(x=>x.eventId);
  assert.deepEqual(await found(),[e.eventId]);
  // una pieza entregada a Kalma
  const piece=await f.editorial.create({negocioId:'bizA',eventId:e.eventId,caption:'Texto',accountId:'ig1',channel:'instagram',scheduledAt:new Date(Date.now()+864e5*5).toISOString(),requestId:'p1'},owner);
  f.editorial.save({...piece,state:'en_kalma'},'t','t');
  // sin permiso
  const denied=await rpc(base,'token-editor-ensayo','retirar_evento',{negocioId:'bizA',eventId:e.eventId,motivo:'Duplicado'});assert.equal(denied.error,true);assert.equal(denied.data.error,'forbidden');
  // vista previa
  const p=await rpc(base,T,'retirar_evento',{negocioId:'bizA',eventId:e.eventId,motivo:'Duplicado'});
  assert.equal(p.data.vistaPrevia,true);assert.equal(p.data.evento.titulo,'Concierto de ensayo');assert.equal(p.data.piezasAfectadas[0].estado,'en_kalma');assert.match(p.data.siguientePaso,/confirmar=true/);assert.ok(p.data.efectos.some(x=>/Kalma/.test(x)));
  assert.equal(f.store.rows.get('eventos/'+e.eventId).data.retirado,undefined);
  // sin código no se ejecuta
  const nocode=await rpc(base,T,'retirar_evento',{negocioId:'bizA',eventId:e.eventId,motivo:'Duplicado',confirmar:true});assert.equal(nocode.data.error,'confirmation_required');
  // confirmar
  const done=await rpc(base,T,'retirar_evento',{negocioId:'bizA',eventId:e.eventId,motivo:'Duplicado',confirmar:true,expectedVersion:p.data.versionActual,codigoConfirmacion:p.data.codigoConfirmacion});
  assert.equal(done.data.retirado,true);assert.equal(done.data.version,2);assert.equal(done.data.kalma.accionRequerida,true);const pack=JSON.parse(done.data.kalma.paquete);assert.equal(pack.action,'cancel');assert.equal(pack.event.eventId,e.eventId);assert.equal(done.data.kalma.firma.length,64);
  assert.deepEqual(await found(),[]);                                    // fuera del buscador público
  assert.equal((await rpc(base,T,'obtener_evento',{negocioId:'bizA',eventId:e.eventId})).data.retirado,true);
  assert.equal((await rpc(base,T,'listar_eventos',{negocioId:'bizA'})).data.eventos.length,0);
  assert.equal((await rpc(base,T,'listar_eventos',{negocioId:'bizA',incluirRetirados:true})).data.eventos.length,1);
  assert.equal((await rpc(base,T,'editar_evento',{negocioId:'bizA',eventId:e.eventId,expectedVersion:2,changesJson:'{"descripcion":"nueva"}',reason:'intento'})).data.error,'event_retired');
  assert.equal((await rpc(base,T,'retirar_evento',{negocioId:'bizA',eventId:e.eventId,motivo:'Otra vez'})).data.error,'already_retired');
  // recuperar
  const vp=await rpc(base,T,'recuperar_evento',{negocioId:'bizA',eventId:e.eventId,motivo:'Se retiró por error',expectedVersion:2});assert.equal(vp.data.vistaPrevia,true);assert.equal(vp.data.escrito,false);assert.equal((await rpc(base,T,'recuperar_evento',{negocioId:'bizA',eventId:e.eventId,motivo:'x ensayo',expectedVersion:2,confirmar:true,simular:true})).data.vistaPrevia,true);
  assert.equal((await rpc(base,T,'recuperar_evento',{negocioId:'bizA',eventId:e.eventId,motivo:'Error',expectedVersion:1,confirmar:true})).data.error,'version_conflict');
  const back=await rpc(base,T,'recuperar_evento',{negocioId:'bizA',eventId:e.eventId,motivo:'Se retiró por error',expectedVersion:2,confirmar:true});assert.equal(back.data.recuperado,true);assert.equal(back.data.version,3);
  assert.deepEqual(await found(),[e.eventId]);
  // otro negocio
  assert.equal((await rpc(base,T,'retirar_evento',{negocioId:'bizB',eventId:e.eventId,motivo:'Prueba'})).data.error,'business_forbidden');
  assert.equal((await rpc(base,T,'recuperar_evento',{negocioId:'bizB',eventId:e.eventId,motivo:'Prueba',expectedVersion:3})).data.error,'business_forbidden');
  assert.equal((await rpc(base,T,'retirar_evento',{negocioId:'bizA',eventId:'ev_nope',motivo:'Prueba'})).data.error,'event_not_found');
 }finally{app.close();f.close();}});
