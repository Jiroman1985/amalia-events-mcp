import test from 'node:test';import assert from 'node:assert/strict';import {checkMapVisibility} from '../web-visibility.mjs';
const response=(status,body,type='application/json')=>({status,headers:{get:k=>k==='content-type'?type:null},json:async()=>body});
test('informe positivo exige ID exacto y usa solo GET al destino fijado',async()=>{
 let called;const r=await checkMapVisibility('ev_123',async(u,o)=>{called={url:String(u),method:o.method};return response(200,{evento:{id:'ev_123'}})});
 assert.equal(r.estado,'visible_en_mapa');assert.equal(called.method,'GET');assert.equal(called.url,'https://amalia-experience.com/api/eventos-mapa?plan=ev_123');
 assert.equal((await checkMapVisibility('ev_123',async()=>response(200,{evento:{id:'other'}}))).estado,'inconcluyente');
});
test('404 reconocido se distingue de errores, caché no acredita ausencia y no se reinsertan eventos',async()=>{
 const missing=await checkMapVisibility('ev_123',async()=>response(404,{error:'plan_no_disponible'}));assert.equal(missing.estado,'no_disponible_en_mapa');assert.match(missing.ayuda,/caché/);
 assert.equal((await checkMapVisibility('ev_123',async()=>response(404,{},'text/html'))).estado,'inconcluyente');
 assert.equal((await checkMapVisibility('ev_123',async()=>response(503,{}))).estado,'inconcluyente');
 assert.equal((await checkMapVisibility('ev_123',async()=>{throw Error('secret')})).estado,'inconcluyente');
});
