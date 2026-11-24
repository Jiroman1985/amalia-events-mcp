import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError,fingerprint } from '../event-domain.mjs';
import { HistoricalFixtureService as EventService } from './helpers/historical-fixtures.mjs';
import { MediaStore } from '../media-store.mjs';
import { Editorial } from '../editorial.mjs';
import { KalmaExport } from '../kalma-export.mjs';

const KEY='ab'.repeat(32),owner={id:'conchi',actions:['*'],businesses:['*']},limited={id:'lim',actions:['read','create','edit'],businesses:['founder']};
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mNQAAAAASUVORK5CYII=';
class MemoryStore {
 constructor(){this.rows=new Map([['negocios/founder',{data:{nombre:'AMALIA'},updateTime:'1'}]]);this.seq=1;}
 async get(c,id){const r=this.rows.get(c+'/'+id);return r?{id,...structuredClone(r)}:null;}
 async list(c){return [...this.rows].filter(([k])=>k.startsWith(c+'/')).map(([k,r])=>({id:k.split('/').at(-1),...structuredClone(r)}));}
 async write(c,id,data,{updateTime,create}={}){const key=c+'/'+id,cur=this.rows.get(key);if((create&&cur)||(!create&&cur?.updateTime!==updateTime))throw new DomainError('version_conflict');const r={data:structuredClone(data),updateTime:String(++this.seq)};this.rows.set(key,r);return {id,...r};}
 async revisions(){return [];}
}
const tomorrow=()=>new Date(Date.now()+86400000*3).toISOString();
async function fixture({autonomous=true}={}){
 const directory=mkdtempSync(join(tmpdir(),'amalia-founder-')),db=new DatabaseSync(':memory:'),store=new MemoryStore();
 const media=new MediaStore({directory,db,publicBase:'https://example.org/amalia-events',downloader:async()=>Buffer.from(PNG,'base64')}),events=new EventService(store,media);
 const accounts=[{id:'ig1',channel:'instagram',username:'amaliaexperience',confirmed:true,businesses:['founder']},{id:'tt1',channel:'tiktok',username:'amalia',confirmed:true,businesses:['founder']}];
 const editorial=new Editorial({db,events,media,accounts,publicBase:'https://example.org',paused:false,autonomy:{businesses:autonomous?['founder']:[]}});
 const kalma=new KalmaExport({events,media,editorial,key:KEY,config:{businessId:'kalma-biz',profile:'lumia_x',instagram:'amaliaexperience'}});
 const event=await events.create({negocioId:'founder',titulo:'Concierto de prueba',descripcion:'Evento de la fuente para el ensayo.',city:'Málaga',provincia:'Provincia de prueba',fechaLocal:'2099-05-10',horaLocal:null,timeZone:'Europe/Madrid',sesionId:'s1',fuentes:[{url:'https://example.org/e',checkedAt:'2026-10-28T07:00:00Z'}],verificationStatus:'verificado',requestId:'ev'},owner);
 const asset=async n=>(await media.persist({url:'https://example.org/'+n+'.png',sourceUrl:'https://example.org/e',negocioId:'founder',rights:{status:'permission',evidence:'Permiso documentado '+n,credit:'Autor '+n}},owner));
 const a1=await asset('uno'),a2=await asset('dos');
 return {directory,db,events,media,editorial,kalma,event,a1,a2,close(){db.close();rmSync(directory,{recursive:true,force:true});},
  piece:(extra={},id='r1')=>editorial.create({negocioId:'founder',eventId:event.eventId,caption:'Texto con ñ y acentos: Sábado',accountId:'ig1',channel:'instagram',scheduledAt:tomorrow(),requestId:id,format:'carrusel',assetIds:[a1.id,a2.id],channels:['instagram','tiktok'],publication:'schedule',...extra},owner)};
}
const sign=text=>createHmac('sha256',Buffer.from(KEY,'hex')).update(text).digest('hex');

test('the contract 3 approval digest equals the one Kalma computes',async()=>{
 const f=await fixture();try{
  const reference={eventId:'ev1',eventVersion:3,caption:'Texto con ñ y acentos: Sábado',assetIds:['a1','a2'],accountId:'ig1',channels:['instagram','tiktok'],platformCaptions:{tiktok:'Corto'},format:'carrusel',scheduledAt:'2099-05-10T10:00:00+02:00',cta:null,render:null,publication:'schedule'};
  assert.equal(f.editorial.digest({...reference,contract:3}),'369b1cfff3550f07831104b41104127ed571d4e37580c2e4180567d1e2072ec0');
 }finally{f.close();}});

test('formats, asset counts and networks are validated like Kalma does',async()=>{
 const f=await fixture();try{
  for(const bad of [{format:'story',channels:['instagram','tiktok']},{format:'post',assetIds:[f.a1.id,f.a2.id],channels:['instagram']},{format:'carrusel',assetIds:[f.a1.id]},{channels:['tiktok']},{channels:['linkedin'],format:'story'},{format:'reel',channels:['instagram'],render:{mode:'kalma_design',slides:[{title:'x'}]}},{scheduledAt:undefined}]){
   const p=await f.piece(bad,'bad'+JSON.stringify(bad).length+Math.random());await assert.rejects(f.editorial.validate(p,owner),/channel_not_allowed|channel_not_in_channels|asset_count_invalid|invalid_render|schedule_required/,JSON.stringify(bad));}
  const ok=await f.piece({},'ok1');await f.editorial.validate(ok,owner);
 }finally{f.close();}});

test('autonomous approval needs configuration, the right action and a scheduled contract 3 piece',async()=>{
 const off=await fixture({autonomous:false});try{const p=await off.piece();await assert.rejects(off.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner),/autonomy_not_configured/);}finally{off.close();}
 const f=await fixture();try{
  const p=await f.piece();await assert.rejects(f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},limited),/forbidden/);
  const old=await f.editorial.create({negocioId:'founder',eventId:f.event.eventId,caption:'Pieza antigua',assetId:f.a1.id,accountId:'ig1',channel:'instagram',scheduledAt:tomorrow(),requestId:'old'},owner);
  await assert.rejects(f.editorial.autoApprove({pieceId:old.id,negocioId:'founder'},owner),/autonomy_requires_scheduled_contract_3_piece/);
  const draft=await f.piece({publication:'draft'},'d');await assert.rejects(f.editorial.autoApprove({pieceId:draft.id,negocioId:'founder'},owner),/autonomy_requires/);
  const soon=await f.piece({scheduledAt:new Date(Date.now()+30000).toISOString()},'soon');await assert.rejects(f.editorial.autoApprove({pieceId:soon.id,negocioId:'founder'},owner),/schedule_too_soon/);
  const approved=await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner);
  assert.equal(approved.state,'aprobado');assert.equal(approved.approval.mode,'autonoma');assert.equal(approved.approval.digest,f.editorial.digest(approved));
  const edited=f.editorial.update({pieceId:p.id,negocioId:'founder',expectedVersion:1,changes:{caption:'Cambio'}},owner);assert.equal(edited.state,'borrador');assert.equal(edited.approval,null);
 }finally{f.close();}});

test('the signed package carries every file, a clean piece and re-delivery stays possible',async()=>{
 const f=await fixture();try{
  const p=await f.piece();await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner);
  const out=await f.kalma.prepare({negocioId:'founder',eventId:f.event.eventId,pieceId:p.id},owner),data=JSON.parse(out.paquete);
  assert.equal(out.firma,sign(out.paquete));assert.equal(data.schema,3);assert.equal(data.action,'deliver');assert.equal(out.contract,3);assert.equal(out.willPublish,false);
  assert.deepEqual(data.assets.map(a=>a.assetId),[f.a1.id,f.a2.id]);assert.deepEqual(data.piece.assetIds,[f.a1.id,f.a2.id]);
  assert.ok(data.assets.every(a=>a.sha256&&a.url&&a.rights.credit));assert.deepEqual(Object.keys(data.piece).sort(),['accountId','aiGenerated','approval','assetIds','caption','channels','cta','eventId','eventVersion','format','id','negocioId','platformCaptions','publication','render','scheduledAt','state','version']);
  assert.equal(data.piece.approval.digest,fingerprint({eventId:data.piece.eventId,eventVersion:data.piece.eventVersion,caption:data.piece.caption,assetIds:data.piece.assetIds,accountId:data.piece.accountId,channels:data.piece.channels,platformCaptions:null,format:data.piece.format,scheduledAt:data.piece.scheduledAt,cta:null,render:null,publication:'schedule',aiGenerated:true}));assert.equal(data.piece.aiGenerated,true);
  const receipt=JSON.stringify({event_id:'x',businessId:'kalma-biz',profile:'lumia_x',sourceBusinessId:'founder',sourceEventId:f.event.eventId,sourcePieceId:p.id,programacion:{estado:'programada'}});
  const done=await f.kalma.receipt({recibo:receipt,firma:sign(receipt),negocioId:'founder'},owner);assert.equal(done.published,false);assert.equal(f.editorial.get(p.id,'founder',owner).state,'programado_en_kalma');
  const again=await f.kalma.prepare({negocioId:'founder',eventId:f.event.eventId,pieceId:p.id},owner);assert.equal(JSON.parse(again.paquete).piece.state,'aprobado');
  await assert.rejects(f.kalma.receipt({recibo:receipt,firma:'0'.repeat(64),negocioId:'founder'},owner),/invalid_kalma_receipt/);
 }finally{f.close();}});

test('a new version can be edited after delivery but never once published',async()=>{
 const f=await fixture();try{
  const p=await f.piece();await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner);
  f.editorial.save({...f.editorial.get(p.id,'founder',owner),state:'programado_en_kalma'},'t','t');
  const v2=f.editorial.update({pieceId:p.id,negocioId:'founder',expectedVersion:1,changes:{caption:'Versión 2',channels:['instagram']}},owner);assert.equal(v2.version,2);assert.equal(v2.state,'borrador');
  f.editorial.save({...v2,state:'publicado_en_kalma'},'t','t');
  assert.throws(()=>f.editorial.update({pieceId:p.id,negocioId:'founder',expectedVersion:2,changes:{caption:'Tarde'}},owner),/piece_locked/);
 }finally{f.close();}});

test('the cancellation package and its receipt stop the pieces of that event',async()=>{
 const f=await fixture();try{
  const p=await f.piece();await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner);
  const out=await f.kalma.cancel({negocioId:'founder',eventId:f.event.eventId,reason:'Cancelado por la sala'},owner),data=JSON.parse(out.paquete);
  assert.equal(out.firma,sign(out.paquete));assert.equal(data.action,'cancel');assert.equal(data.schema,3);assert.equal(data.event.eventId,f.event.eventId);assert.equal(data.reason,'Cancelado por la sala');
  const receipt=JSON.stringify({accion:'cancelar',businessId:'kalma-biz',profile:'lumia_x',sourceBusinessId:'founder',sourceEventId:f.event.eventId,piezas:[{pieza:p.id,estado:'detenida'}]});
  const done=await f.kalma.receipt({recibo:receipt,firma:sign(receipt),negocioId:'founder'},owner);assert.deepEqual(done.detenidas,[p.id]);assert.equal(f.editorial.get(p.id,'founder',owner).state,'detenido_en_kalma');
 }finally{f.close();}});

test('Kalma status receipts update pieces with the real link and reject stale or foreign data',async()=>{
 const f=await fixture();try{
  const p=await f.piece();await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner);
  const status=(extra={},item={})=>JSON.stringify({negocio:'kalma-biz',perfil:'lumia_x',generado:new Date().toISOString(),piezas:[{pieza:p.id,evento:f.event.eventId,version_pieza:1,version_evento:1,resumen:'publicada',publicaciones:[{post:'p1',estado:'published',redes:[{red:'instagram',estado:'published',id_en_red:'ig_9',enlace:'https://www.instagram.com/p/ABC/'},{red:'tiktok',estado:'published',id_en_red:'tt_9',enlace:null}]}],...item}],...extra});
  const good=status();const r=await f.kalma.status({recibo:good,firma:sign(good),negocioId:'founder'},owner);
  assert.equal(r.actualizadas[0].estado,'publicado_en_kalma');assert.equal(r.actualizadas[0].redes[0].enlace,'https://www.instagram.com/p/ABC/');
  const saved=f.editorial.get(p.id,'founder',owner);assert.equal(saved.state,'publicado_en_kalma');assert.equal(saved.kalma.links[0].id_en_red,'ig_9');
  const stale=status({generado:new Date(Date.now()-3600000).toISOString()});await assert.rejects(f.kalma.status({recibo:stale,firma:sign(stale),negocioId:'founder'},owner),/stale_kalma_status/);
  const foreign=status({negocio:'otro'});await assert.rejects(f.kalma.status({recibo:foreign,firma:sign(foreign),negocioId:'founder'},owner),/kalma_destination_mismatch/);
  await assert.rejects(f.kalma.status({recibo:good,firma:'1'.repeat(64),negocioId:'founder'},owner),/invalid_kalma_receipt/);
  const old=status({},{version_pieza:7});const ignored=await f.kalma.status({recibo:old,firma:sign(old),negocioId:'founder'},owner);assert.equal(ignored.actualizadas.length,0);assert.equal(ignored.ignoradas[0].motivo,'versión distinta de la actual');
  const unknown=status({},{pieza:'piece_nope'});assert.equal((await f.kalma.status({recibo:unknown,firma:sign(unknown),negocioId:'founder'},owner)).ignoradas[0].motivo,'pieza desconocida');
 }finally{f.close();}});

test('legacy pieces keep their original digest and review flow',async()=>{
 const f=await fixture();try{
  const legacy=await f.editorial.create({negocioId:'founder',eventId:f.event.eventId,caption:'Texto revisable',assetId:f.a1.id,accountId:'ig1',channel:'instagram',scheduledAt:tomorrow(),requestId:'legacy'},owner);
  assert.equal(legacy.contract,undefined);assert.equal(f.editorial.digest(legacy),fingerprint({eventId:legacy.eventId,eventVersion:legacy.eventVersion,caption:legacy.caption,assetId:legacy.assetId,accountId:legacy.accountId,channel:legacy.channel,scheduledAt:legacy.scheduledAt,cta:legacy.cta}));
  const review=await f.editorial.requestReview({pieceId:legacy.id,negocioId:'founder'},owner);const approved=await f.editorial.approve(review.reviewUrl.split('/').at(-1),'Iñaki');assert.equal(approved.state,'aprobado');
  const out=await f.kalma.prepare({negocioId:'founder',eventId:f.event.eventId,pieceId:legacy.id},owner);assert.equal(JSON.parse(out.paquete).schema,2);
 }finally{f.close();}});
