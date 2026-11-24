import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp,authenticate } from '../server-v2.mjs';
import { hash } from '../event-domain.mjs';
test('HTTP MCP authenticates, exposes complete tools and does not expose the key',async()=>{
 const principal={id:'test',tokenHash:hash('fixture-token-not-for-production'),actions:['*'],businesses:['*']};
 const editorial={pausedNow:()=>true},ctx={editorial,publicBase:'https://example.org',media:{serve:()=>null}};
 const app=createApp(ctx,[principal]);await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.address().port;
 try{
  const payload={jsonrpc:'2.0',id:1,method:'tools/list'};
  const unauthorized=await fetch(base+'/mcp',{method:'POST',body:JSON.stringify(payload),headers:{'content-type':'application/json'}});assert.equal(unauthorized.status,401);
  const r=await fetch(base+'/mcp',{method:'POST',body:JSON.stringify(payload),headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer fixture-token-not-for-production'}});assert.equal(r.status,200);const result=await r.json(),names=result.result.tools.map(t=>t.name);
  for(const expected of ['preparar_admision','admitir_candidato','crear_evento','obtener_evento','listar_eventos','editar_evento','historial_evento','guardar_imagen','subir_imagen','subir_imagen_fragmentada','solicitar_revision_pieza','preparar_publicacion_kalma','exportar_evento_kalma','buscar_eventos_publicos'])assert.ok(names.includes(expected));
  assert.equal((await fetch(base+'/health').then(r=>r.json())).version,'2.25.11');
  assert.equal(result.result.tools.find(t=>t.name==='preparar_admision').annotations.readOnlyHint,true);
  const denied=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer fixture-token-not-for-production'},body:JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'crear_evento',arguments:{negocioId:'b',titulo:'Concierto de ensayo',descripcion:'Ensayo de protección',city:'Málaga',fechaLocal:'2027-01-01',sesionId:'s',fuentes:[{url:'https://example.org/e'}]}}})}).then(r=>r.json());
  assert.equal(denied.result.isError,true);assert.equal(denied.result.structuredContent.result.error,'direct_creation_disabled');
  assert.equal(authenticate('Bearer wrong',[principal]),null);
 }finally{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));}
});
test('large private upload passes authenticated MCP only, verifies business and preserves payload',async()=>{
 const principal={id:'test',tokenHash:hash('fixture-token-not-for-production'),actions:['admit','read'],businesses:['bizA']};
 const calls=[],ctx={editorial:{pausedNow:()=>true},publicBase:'https://example.org',events:{business:async id=>calls.push(id)},media:{upload:async input=>({id:'asset-fixture',sha256:input.sha256,size:input.base64.length}),serve:()=>null}};
 const app=createApp(ctx,[principal]);await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.address().port;
 const input={negocioId:'bizA',base64:Buffer.alloc(100000,1).toString('base64'),sha256:'a'.repeat(64),sourceUrl:'https://example.org/art',rights:{status:'owned',evidence:'original',credit:'fixture'}};
 const send=(body,auth=true)=>fetch(base+'/mcp',{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(auth?{authorization:'Bearer fixture-token-not-for-production'}:{})}});
 try{
 const payload={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'subir_imagen',arguments:input}};
 assert.equal((await send(payload,false)).status,401);assert.deepEqual(calls,[]);
 const result=await(await send(payload)).json();assert.equal(result.result.structuredContent.result.size,input.base64.length);assert.deepEqual(calls,['bizA']);
 const denied=await(await send({...payload,params:{...payload.params,arguments:{...input,negocioId:'bizB'}}})).json();assert.equal(denied.result.isError,true);assert.deepEqual(calls,['bizA']);
 assert.equal((await send({jsonrpc:'2.0',id:3,method:'tools/list',padding:'a'.repeat(70000)})).status,400);
 }finally{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));}
});
