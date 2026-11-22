import { createHmac,timingSafeEqual } from 'node:crypto';
import { authorize,fail,fingerprint } from './event-domain.mjs';
const SHOWN={programada:'programado_en_kalma',publicada:'publicado_en_kalma',fallida:'error_en_kalma',detenida:'detenido_en_kalma',parcial:'parcial_en_kalma'};
export class KalmaExport {
 constructor({key,config,events,media,editorial}){Object.assign(this,{key,config,events,media,editorial});}
 sign(text){return createHmac('sha256',Buffer.from(this.key,'hex')).update(text).digest('hex');}
 verify(text,signature,code){const expected=Buffer.from(this.sign(text)),given=Buffer.from(String(signature||''));if(expected.length!==given.length||!timingSafeEqual(expected,given))fail(code);}
 target(){return {targetBusinessId:this.config.businessId,targetProfile:this.config.profile,targetInstagram:this.config.instagram};}
 asset(a){return {assetId:a.id,url:a.url,sha256:a.sha256,mime:a.mime,sourceUrl:a.sourceUrl,rights:a.rights};}
 cleanPiece(p){return {id:p.id,negocioId:p.negocioId,eventId:p.eventId,eventVersion:p.eventVersion,version:p.version,caption:p.caption,assetIds:p.assetIds,accountId:p.accountId,channels:p.channels,platformCaptions:p.platformCaptions??null,format:p.format,scheduledAt:p.scheduledAt,cta:p.cta??null,render:p.render??null,publication:p.publication,...(Object.hasOwn(p,'aiGenerated')?{aiGenerated:p.aiGenerated}:{}),state:'aprobado',approval:p.approval,...(p.test?{test:true}:{})};}
 async prepare(input,principal){
  authorize(principal,input.negocioId,'edit');if(!this.key||!this.config?.businessId)fail('kalma_not_configured');
  const event=await this.events.get(input.eventId,input.negocioId,principal);let piece=null;
  if(!input.pieceId&&event.retirado===true)fail('event_retired',{eventId:event.eventId});
  if(input.pieceId){if(this.editorial.pausedNow())fail('publication_paused');piece=this.editorial.get(input.pieceId,input.negocioId,principal);if(piece.eventId!==event.eventId)fail('piece_event_mismatch');await this.editorial.validate(piece,principal);this.editorial.current(piece);if(!piece.scheduledAt)fail('kalma_schedule_required');const redelivery=piece.contract===3&&['en_kalma','programado_en_kalma'].includes(piece.state);if((piece.state!=='aprobado'&&!redelivery)||piece.approval?.digest!==this.editorial.digest(piece))fail('approval_required');}
  if(piece?.test){if(event.prueba!==true)fail('test_piece_requires_test_event');if(piece.publication!=='draft')fail('test_piece_draft_only');if(piece.render)fail('test_piece_no_render');}
  if(!piece&&event.prueba===true)fail('test_event_catalog_not_exportable');
  const v3=piece?.contract===3,now=Date.now();
  const deliveryId='delivery_'+fingerprint({eventId:event.eventId,eventVersion:event.version,pieceId:piece?.id||null,pieceVersion:piece?.version||null}).slice(0,40);
  const common={schema:v3?3:2,source:'amalia-events',...this.target(),event,issuedAt:now,expiresAt:now+15*60000,deliveryId,...(piece?.test?{test:true}:{})};
  const payload=JSON.stringify(v3?{...common,action:'deliver',assets:piece.assetIds.map(id=>this.asset(this.media.get(id,input.negocioId,principal))),piece:this.cleanPiece(piece)}:{...common,asset:(piece?.assetId||event.assetId)?this.media.get(piece?.assetId||event.assetId,input.negocioId,principal):null,piece});
  return {paquete:payload,firma:this.sign(payload),destination:'Kalma',targetBusinessId:this.config.businessId,nextTool:'importar_evento_amalia',willPublish:false,contract:v3?3:2,note:piece?(piece.test?'PRUEBA: Kalma recibirá la pieza marcada como test; quedará en borrador rotulado [PRUEBA] y no podrá programarse ni publicarse.':(v3&&piece.publication==='schedule'?'Kalma recibirá la pieza aprobada y, si la autogestión de AMALIA está activa, la dejará programada en las redes indicadas.':'Kalma recibirá el texto exacto como borrador con su aprobación de origen; su publicación se gestiona desde Kalma.')):'Kalma recibirá una copia de trabajo del evento; Firebase/eventos sigue siendo la fuente canónica.'};
 }
 async cancel(input,principal){
  authorize(principal,input.negocioId,'edit');if(!this.key||!this.config?.businessId)fail('kalma_not_configured');
  const event=await this.events.get(input.eventId,input.negocioId,principal),now=Date.now();
  if(input.redes&&!input.pieceId)fail('piece_required_for_networks');
  if(input.pieceId){const piece=this.editorial.get(input.pieceId,input.negocioId,principal);if(piece.eventId!==event.eventId)fail('piece_event_mismatch');if(input.redes&&input.redes.some(r=>!(piece.channels||['instagram']).includes(r)))fail('network_not_in_piece');}
  const payload=JSON.stringify({schema:3,source:'amalia-events',action:'cancel',...(input.pieceId?{pieceId:input.pieceId}:{}),...(input.redes?{redes:input.redes}:{}),...(event.prueba===true?{test:true}:{}) ,...this.target(),event:{eventId:event.eventId,negocioId:event.negocioId,version:event.version,...(event.prueba===true?{prueba:true}:{})},reason:input.reason,issuedAt:now,expiresAt:now+15*60000,deliveryId:'cancel_'+fingerprint({eventId:event.eventId,version:event.version,reason:input.reason,pieceId:input.pieceId||null,redes:input.redes||null}).slice(0,40)});
  return {paquete:payload,firma:this.sign(payload),destination:'Kalma',nextTool:'importar_evento_amalia',willPublish:false,effect:'Kalma detendrá '+(input.pieceId?(input.redes?'solo las redes indicadas de la pieza':'la pieza indicada'):'las piezas de este evento')+' si aún no ha salido y retirará su programación; nunca despublica.'};
 }
 async receipt({recibo,firma,negocioId},principal){  authorize(principal,negocioId,'edit');if(!this.key)fail('kalma_not_configured');
  this.verify(recibo,firma,'invalid_kalma_receipt');const r=JSON.parse(recibo);
  if(r.businessId!==this.config.businessId||r.profile!==this.config.profile||r.sourceBusinessId!==negocioId)fail('kalma_destination_mismatch');
  await this.events.get(r.sourceEventId,negocioId,principal);
  if(r.accion==='cancelar'){const stopped=[];for(const p of this.editorial.list(negocioId,principal)){if(p.eventId!==r.sourceEventId||['publicado','publicado_en_kalma','detenido_en_kalma'].includes(p.state))continue;const item=(r.piezas||[]).find(x=>x.pieza===p.id);if(item?.estado==='detenida'||item?.estado==='ya_detenida'){this.editorial.save({...p,state:'detenido_en_kalma',kalma:r},'kalma_stopped',principal.id);stopped.push(p.id);}else if(item?.estado==='redes_canceladas'){this.editorial.save({...p,kalma:{...(p.kalma||{}),redesCanceladas:item.redes,redesActivas:item.redes_activas,cancelAt:new Date().toISOString()}},'kalma_networks_cancelled',principal.id);}}return {verifiedReceipt:true,kalma:r,published:false,detenidas:stopped};}
  if(r.sourcePieceId){const p=this.editorial.get(r.sourcePieceId,negocioId,principal);if(p.eventId!==r.sourceEventId)fail('piece_event_mismatch');const next=p.contract===3&&r.programacion?.estado==='programada'?'programado_en_kalma':'en_kalma';if(p.state!==next)this.editorial.save({...p,state:next,kalma:r},next==='en_kalma'?'kalma_draft_received':'kalma_scheduled',principal.id);}
  return {verifiedReceipt:true,kalma:r,published:false,programacion:r.programacion||null};
 }
 async status({recibo,firma,negocioId},principal){
  authorize(principal,negocioId,'edit');if(!this.key)fail('kalma_not_configured');
  this.verify(recibo,firma,'invalid_kalma_receipt');const r=JSON.parse(recibo);
  if(r.negocio!==this.config.businessId||r.perfil!==this.config.profile)fail('kalma_destination_mismatch');
  if(!(Date.parse(r.generado)>Date.now()-15*60000))fail('stale_kalma_status');
  const updated=[],ignored=[];
  for(const item of r.piezas||[]){
   let p;try{p=this.editorial.get(item.pieza,negocioId,principal);}catch{ignored.push({pieza:item.pieza,motivo:'pieza desconocida'});continue;}
   if(item.version_pieza!==p.version){ignored.push({pieza:p.id,motivo:'versión distinta de la actual'});continue;}
   const next=SHOWN[item.resumen];if(!next){ignored.push({pieza:p.id,motivo:'sin cambio ('+item.resumen+')'});continue;}
   const links=(item.publicaciones||[]).flatMap(x=>x.redes||[]).map(n=>({red:n.red,estado:n.estado,enlace:n.enlace||null,id_en_red:n.id_en_red||null}));
   if(p.state!==next||fingerprint(p.kalma?.links||null)!==fingerprint(links))this.editorial.save({...p,state:next,kalma:{...(p.kalma||{}),estado:item.resumen,links,statusAt:r.generado}},'kalma_status',principal.id);
   updated.push({pieza:p.id,estado:next,redes:links});
  }
  return {verifiedReceipt:true,actualizadas:updated,ignoradas:ignored};
 }
}
