// Autonomía de AMALIA en Instagram, TikTok y LinkedIn: reglas del lado del MCP de eventos y contenido.
// Entorno de prueba aislado (SQLite en memoria, almacén simulado): no toca Firebase, Kalma ni ninguna red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '../event-domain.mjs';
import { HistoricalFixtureService as EventService } from './helpers/historical-fixtures.mjs';
import { MediaStore } from '../media-store.mjs';
import { Editorial } from '../editorial.mjs';
import { KalmaExport } from '../kalma-export.mjs';

const KEY='ab'.repeat(32),owner={id:'conchi',actions:['*'],businesses:['*']},other={id:'ia',actions:['read','edit'],businesses:['ajeno']},limited={id:'lim',actions:['read','create','edit'],businesses:['founder']};
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mNQAAAAASUVORK5CYII=';
class MemoryStore {
 constructor(){this.rows=new Map([['negocios/founder',{data:{nombre:'AMALIA'},updateTime:'1'}],['negocios/ajeno',{data:{nombre:'Otro'},updateTime:'1'}]]);this.seq=1;}
 async get(c,id){const r=this.rows.get(c+'/'+id);return r?{id,...structuredClone(r)}:null;}
 async list(c){return [...this.rows].filter(([k])=>k.startsWith(c+'/')).map(([k,r])=>({id:k.split('/').at(-1),...structuredClone(r)}));}
 async write(c,id,data,{updateTime,create}={}){const key=c+'/'+id,cur=this.rows.get(key);if((create&&cur)||(!create&&cur?.updateTime!==updateTime))throw new DomainError('version_conflict');const r={data:structuredClone(data),updateTime:String(++this.seq)};this.rows.set(key,r);return {id,...r};}
 async revisions(){return [];}
}
const inDays=n=>new Date(Date.now()+86400000*n).toISOString();
async function fixture({linkedinConfirmed=true}={}){
 const directory=mkdtempSync(join(tmpdir(),'amalia-redes-')),db=new DatabaseSync(':memory:'),store=new MemoryStore();
 const media=new MediaStore({directory,db,publicBase:'https://example.org/amalia-events',downloader:async()=>Buffer.from(PNG,'base64')}),events=new EventService(store,media);
 const accounts=[{id:'ig1',channel:'instagram',username:'amaliaexperience',confirmed:true,businesses:['founder']},{id:'tt1',channel:'tiktok',username:'amaliaexperience',confirmed:true,businesses:['founder']},{id:'li1',channel:'linkedin',username:'amalia experience',confirmed:linkedinConfirmed,businesses:['founder']}];
 const editorial=new Editorial({db,events,media,accounts,publicBase:'https://example.org',paused:false,autonomy:{businesses:['founder']}});
 const kalma=new KalmaExport({events,media,editorial,key:KEY,config:{businessId:'kalma-biz',profile:'lumia_x',instagram:'amaliaexperience'}});
 const event=await events.create({negocioId:'founder',titulo:'Concierto de prueba',descripcion:'Evento de la fuente para el ensayo.',city:'Málaga',fechaLocal:'2099-05-10',horaLocal:null,timeZone:'Europe/Madrid',sesionId:'s1',fuentes:[{url:'https://example.org/e',checkedAt:'2026-10-28T07:00:00Z'}],verificationStatus:'verificado',requestId:'ev'},owner);
 const assets=[];for(let i=0;i<11;i++)assets.push(await media.persist({url:`https://example.org/f${i}.png`,sourceUrl:'https://example.org/e',negocioId:'founder',rights:{status:'permission',evidence:'Permiso documentado '+i,credit:'Autor '+i}},owner));
 const ids=n=>assets.slice(0,n).map(a=>a.id);let seq=0;
 const piece=(extra={})=>editorial.create({negocioId:'founder',eventId:event.eventId,caption:'Texto aprobado',accountId:'ig1',channel:'instagram',scheduledAt:inDays(3),requestId:'r'+(++seq),format:'carrusel',assetIds:ids(4),channels:['instagram'],publication:'schedule',...extra},owner);
 return {db,editorial,kalma,event,assets,ids,piece,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const reason=(p,re)=>assert.rejects(p,e=>{assert.match(e.code||e.message,re);return true;});

test('four independent Instagram stories and one TikTok-only photo post share the same files in the same order',async()=>{
 const f=await fixture();try{
  const files=f.ids(4);
  const stories=await f.piece({format:'story',assetIds:files,channels:['instagram']});
  const tiktok=await f.piece({format:'carrusel',assetIds:files,channels:['tiktok'],accountId:'tt1',channel:'tiktok'});
  await f.editorial.validate(stories,owner);await f.editorial.validate(tiktok,owner);
  assert.deepEqual(stories.assetIds,tiktok.assetIds);assert.deepEqual(tiktok.channels,['tiktok']);
  const a=await f.editorial.autoApprove({pieceId:stories.id,negocioId:'founder'},owner),b=await f.editorial.autoApprove({pieceId:tiktok.id,negocioId:'founder'},owner);
  assert.equal(a.state,'aprobado');assert.equal(b.state,'aprobado');assert.notEqual(a.approval.digest,b.approval.digest);
  const packet=JSON.parse((await f.kalma.prepare({pieceId:tiktok.id,eventId:f.event.eventId,negocioId:'founder'},owner)).paquete);
  assert.deepEqual(packet.piece.channels,['tiktok']);assert.deepEqual(packet.assets.map(x=>x.assetId),files);assert.equal(packet.piece.format,'carrusel');
 }finally{f.close();}});

test('LinkedIn is allowed for post, carousel and reel, but only with a confirmed account and at most 9 files',async()=>{
 const f=await fixture();try{
  for(const extra of [{format:'post',assetIds:f.ids(1),channels:['linkedin']},{format:'carrusel',assetIds:f.ids(5),channels:['linkedin','tiktok']},{format:'post',assetIds:f.ids(1),channels:['instagram','linkedin']}]){
   const p=await f.piece({accountId:'li1',channel:'linkedin',...extra});await f.editorial.validate(p,owner);}
  const nine=await f.piece({accountId:'li1',channel:'linkedin',assetIds:f.ids(9),channels:['linkedin']});await f.editorial.validate(nine,owner);
  const ten=await f.piece({accountId:'li1',channel:'linkedin',assetIds:f.ids(10),channels:['linkedin']});await reason(f.editorial.validate(ten,owner),/too_many_files_for_network/);
 }finally{f.close();}
 const g=await fixture({linkedinConfirmed:false});try{
  const p=await g.piece({format:'post',assetIds:g.ids(1),channels:['linkedin'],accountId:'li1',channel:'linkedin'});await reason(g.editorial.validate(p,owner),/account_not_confirmed/);
 }finally{g.close();}});

test('unsupported combinations are rejected with the admitted networks and an alternative, never silently changed',async()=>{
 const f=await fixture();try{
  const cases=[{format:'story',channels:['instagram','tiktok']},{format:'story',channels:['linkedin'],accountId:'li1',channel:'linkedin'},{format:'post',assetIds:f.ids(1),channels:['tiktok'],accountId:'tt1',channel:'tiktok'},{channels:['instagram','instagram']},{channels:['tiktok']}];
  for(const bad of cases){const p=await f.piece(bad);await assert.rejects(f.editorial.validate(p,owner),e=>{assert.match(e.code,/channel_not_allowed|channel_required|channel_not_in_channels/);return true;},JSON.stringify(bad));}
  await assert.rejects(f.editorial.validate(await f.piece({format:'story',channels:['linkedin'],accountId:'li1',channel:'linkedin'}),owner),e=>{
   assert.equal(e.code,'channel_not_allowed');assert.deepEqual(e.details.admite,['Instagram']);assert.match(e.details.alternativa,/carrusel/);return true;});
  await assert.rejects(f.editorial.validate(await f.piece({format:'post',assetIds:f.ids(1),channels:['tiktok'],accountId:'tt1',channel:'tiktok'}),owner),e=>{assert.deepEqual(e.details.admite,['Instagram','LinkedIn']);assert.match(e.details.alternativa,/TikTok/);return true;});
 }finally{f.close();}});

test('there is no internal daily, frequency or lead-time cap: only the provider technical window applies',async()=>{
 const f=await fixture();try{
  const day=new Date(Date.now()+86400000*4);day.setUTCHours(10,0,0,0);
  for(let i=0;i<6;i++){const p=await f.piece({scheduledAt:new Date(day.getTime()+i*600000).toISOString(),assetIds:f.ids(2)});assert.equal((await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner)).state,'aprobado');}
  const five=await f.piece({scheduledAt:new Date(Date.now()+5*60000).toISOString()});assert.equal((await f.editorial.autoApprove({pieceId:five.id,negocioId:'founder'},owner)).state,'aprobado');
  const far=await f.piece({scheduledAt:inDays(300)});assert.equal((await f.editorial.autoApprove({pieceId:far.id,negocioId:'founder'},owner)).state,'aprobado');
  const soon=await f.piece({scheduledAt:new Date(Date.now()+30000).toISOString()});await reason(f.editorial.autoApprove({pieceId:soon.id,negocioId:'founder'},owner),/schedule_too_soon/);
  const beyond=await f.piece({scheduledAt:inDays(400)});await reason(f.editorial.autoApprove({pieceId:beyond.id,negocioId:'founder'},owner),/schedule_too_far/);
 }finally{f.close();}});

test('permissions: autonomous approval needs the action and a configured business; another business cannot read or approve it',async()=>{
 const f=await fixture();try{
  const p=await f.piece();
  await reason(f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},limited),/forbidden/);
  await reason(f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},other),/business_forbidden|forbidden/);
  await reason(f.editorial.autoApprove({pieceId:p.id,negocioId:'ajeno'},owner),/autonomy_not_configured/);
  assert.throws(()=>f.editorial.get(p.id,'founder',other),/business_forbidden/);
  await reason(f.kalma.prepare({pieceId:p.id,eventId:f.event.eventId,negocioId:'founder'},other),/business_forbidden|forbidden/);
 }finally{f.close();}});

test('editing an approved piece invalidates the approval and a new approval is needed for the exact new version',async()=>{
 const f=await fixture();try{
  const p=await f.piece({channels:['instagram','tiktok','linkedin'],accountId:'ig1',channel:'instagram'});
  const approved=await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner);
  const edited=f.editorial.update({pieceId:p.id,negocioId:'founder',expectedVersion:approved.version,changes:{channels:['tiktok','linkedin'],accountId:'tt1',channel:'tiktok',caption:'Nuevo texto'}},owner);
  assert.equal(edited.state,'borrador');assert.equal(edited.approval,null);assert.equal(edited.version,approved.version+1);
  await reason(f.kalma.prepare({pieceId:p.id,eventId:f.event.eventId,negocioId:'founder'},owner),/approval_required/);
  const again=await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner);
  const packet=JSON.parse((await f.kalma.prepare({pieceId:p.id,eventId:f.event.eventId,negocioId:'founder'},owner)).paquete);
  assert.deepEqual(packet.piece.channels,['tiktok','linkedin']);assert.equal(packet.piece.approval.digest,f.editorial.digest(again));
 }finally{f.close();}});

test('cancellation packages can target the event, one piece, or only some networks of a piece',async()=>{
 const f=await fixture();try{
  const p=await f.piece({channels:['instagram','tiktok'],assetIds:f.ids(3)});
  const sign=text=>createHmac('sha256',Buffer.from(KEY,'hex')).update(text).digest('hex');
  const whole=await f.kalma.cancel({eventId:f.event.eventId,negocioId:'founder',reason:'Evento cancelado'},owner);
  assert.equal(whole.firma,sign(whole.paquete));assert.equal(JSON.parse(whole.paquete).pieceId,undefined);
  const piece=JSON.parse((await f.kalma.cancel({eventId:f.event.eventId,negocioId:'founder',reason:'Pieza retirada',pieceId:p.id},owner)).paquete);
  assert.equal(piece.pieceId,p.id);assert.equal(piece.redes,undefined);
  const nets=await f.kalma.cancel({eventId:f.event.eventId,negocioId:'founder',reason:'Quitar TikTok',pieceId:p.id,redes:['tiktok']},owner);
  const data=JSON.parse(nets.paquete);assert.deepEqual(data.redes,['tiktok']);assert.equal(data.action,'cancel');assert.equal(nets.firma,sign(nets.paquete));
  assert.notEqual(data.deliveryId,piece.deliveryId);
  await reason(f.kalma.cancel({eventId:f.event.eventId,negocioId:'founder',reason:'Sin pieza',redes:['tiktok']},owner),/piece_required_for_networks/);
  await reason(f.kalma.cancel({eventId:f.event.eventId,negocioId:'founder',reason:'Red ajena a la pieza',pieceId:p.id,redes:['linkedin']},owner),/network_not_in_piece/);
  await reason(f.kalma.cancel({eventId:f.event.eventId,negocioId:'founder',reason:'Pieza inexistente',pieceId:'no-existe'},owner),/piece_not_found/);
 }finally{f.close();}});

test('a Kalma receipt that cancelled only some networks keeps the piece scheduled and records which networks are still active',async()=>{
 const f=await fixture();try{
  const p=await f.piece({channels:['instagram','tiktok']});await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner);
  const base=f.editorial.get(p.id,'founder',owner);f.editorial.save({...base,state:'programado_en_kalma'},'kalma_scheduled','test');
  const sign=text=>createHmac('sha256',Buffer.from(KEY,'hex')).update(text).digest('hex');
  const recibo=JSON.stringify({deliveryId:'d',accion:'cancelar',businessId:'kalma-biz',profile:'lumia_x',sourceBusinessId:'founder',sourceEventId:f.event.eventId,piezas:[{pieza:p.id,estado:'redes_canceladas',redes:{tiktok:'cancelada'},redes_activas:['instagram']}]});
  const r=await f.kalma.receipt({recibo,firma:sign(recibo),negocioId:'founder'},owner);
  assert.equal(r.verifiedReceipt,true);assert.deepEqual(r.detenidas,[]);
  const after=f.editorial.get(p.id,'founder',owner);assert.equal(after.state,'programado_en_kalma');assert.deepEqual(after.kalma.redesActivas,['instagram']);assert.deepEqual(after.kalma.redesCanceladas,{tiktok:'cancelada'});
  assert.ok(f.editorial.history(p.id,'founder',owner).some(h=>h.action==='kalma_networks_cancelled'));
  const full=JSON.stringify({deliveryId:'d2',accion:'cancelar',businessId:'kalma-biz',profile:'lumia_x',sourceBusinessId:'founder',sourceEventId:f.event.eventId,piezas:[{pieza:p.id,estado:'detenida'}]});
  const r2=await f.kalma.receipt({recibo:full,firma:sign(full),negocioId:'founder'},owner);assert.deepEqual(r2.detenidas,[p.id]);assert.equal(f.editorial.get(p.id,'founder',owner).state,'detenido_en_kalma');
 }finally{f.close();}});

test('pausing deliveries blocks new packages and every state change is recorded with its author',async()=>{
 const f=await fixture();try{
  const p=await f.piece();await f.editorial.autoApprove({pieceId:p.id,negocioId:'founder'},owner);
  f.editorial.pause(true,owner);await reason(f.kalma.prepare({pieceId:p.id,eventId:f.event.eventId,negocioId:'founder'},owner),/publication_paused/);
  f.editorial.pause(false,owner);await f.kalma.prepare({pieceId:p.id,eventId:f.event.eventId,negocioId:'founder'},owner);
  const history=f.editorial.history(p.id,'founder',owner);assert.ok(history.every(h=>h.actor&&h.at&&h.hash));assert.ok(history.some(h=>h.action==='autonomous_approved'&&h.actor==='conchi'));
 }finally{f.close();}});
