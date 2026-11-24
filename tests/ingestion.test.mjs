import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError,canonicalInput,eventIdentity,originKey } from '../event-domain.mjs';
import { HistoricalFixtureService as EventService } from './helpers/historical-fixtures.mjs';

const owner={id:'conchi',actions:['*'],businesses:['*']};
const base=(overrides={})=>({negocioId:'bizA',titulo:'Concierto de prueba',descripcion:'Evento de la fuente para el ensayo.',city:'Málaga',provincia:'Provincia de prueba',fechaLocal:'2027-05-10',horaLocal:null,timeZone:'Europe/Madrid',sesionId:'fuente-sesion-A',fuentes:[{url:'https://example.org/event',checkedAt:'2026-10-28T07:00:00Z'}],...overrides});
class MemoryStore {
 constructor(){this.rows=new Map([['negocios/bizA',{data:{nombre:'A'},updateTime:'1'}],['negocios/bizB',{data:{nombre:'B'},updateTime:'2'}]]);this.audit=new Map();this.seq=2;}
 async get(c,id){const r=this.rows.get(c+'/'+id);return r?{id,...structuredClone(r)}:null;}
 async list(c,{business,cursor,limit}={}){let out=[...this.rows].filter(([key,r])=>key.startsWith(c+'/')&&!key.includes('/revisiones/')&&(!business||r.data.negocioId===business)).map(([key,r])=>({id:key.split('/').at(-1),...structuredClone(r)}));out.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);if(cursor)out=out.filter(r=>r.id>=cursor);if(limit)out=out.slice(0,limit);return out;}
 async write(c,id,data,{updateTime,create,audit,request,reserve}={}){const key=c+'/'+id,current=this.rows.get(key);if((create&&current)||(!create&&updateTime&&current?.updateTime!==updateTime)||(request&&this.rows.has('amalia_event_requests/'+request.id))||(reserve&&this.rows.has('amalia_event_reservations/'+reserve.id)))throw new DomainError('version_conflict');const r={data:structuredClone(data),updateTime:String(++this.seq)};this.rows.set(key,r);if(audit)this.audit.set(id,[...(this.audit.get(id)||[]),structuredClone(audit)]);if(request)this.rows.set('amalia_event_requests/'+request.id,{data:request.data,updateTime:String(this.seq)});if(reserve)this.rows.set('amalia_event_reservations/'+reserve.id,{data:reserve.data,updateTime:String(this.seq)});return {id,...r};}
 async revisions(id){return this.audit.get(id)||[];}
}
const mediaStub={persist:async()=>{throw new Error('no media in test');},get:()=>{throw new Error('no media in test');}};
const svc=store=>new EventService(store,mediaStub);

test('origen reserves identity atomically and retries return the same event',async()=>{
 const store=new MemoryStore(),events=svc(store);
 const input=base({origen:{proveedor:'fever',id_externo:'abc-1',id_sesion:'2027-05-10-noche'}});
 const a=await events.create(input,owner);
 assert.equal(a.created,true);
 const res=await store.get('amalia_event_reservations',originKey(input.origen));
 assert.equal(res.data.eventId,a.eventId);
 const b=await events.create(base({origen:input.origen}),owner);
 assert.equal(b.alreadyCreated,true);
 assert.equal(b.eventId,a.eventId);
});
test('same origen with a different payload conflicts and points to the existing event',async()=>{
 const store=new MemoryStore(),events=svc(store);
 const a=await events.create(base({origen:{proveedor:'fever',id_externo:'abc-2',id_sesion:'s1'}}),owner);
 await assert.rejects(events.create(base({negocioId:'bizB',titulo:'Otro título distinto',origen:{proveedor:'fever',id_externo:'abc-2',id_sesion:'s1'}}),owner),/duplicate_event_conflict/);
 assert.ok(true,a.eventId);
});
test('origen requires proveedor, id_externo and id_sesion',()=>{
 assert.throws(()=>canonicalInput(base({origen:{proveedor:'fever',id_externo:'',id_sesion:'s'}})),/invalid_origin/);
 const e=canonicalInput(base({sesionId:undefined,origen:{proveedor:'fever',id_externo:'x',id_sesion:'ses-9'}}));
 assert.equal(e.sesionId,'ses-9');
 assert.equal(e.sesionExplicita,true);
 assert.equal(e.fuentes[0].sourceId,'x');
});
test('precioInfo maps faithfully and never turns unknown into zero',()=>{
 const u=canonicalInput(base());
 assert.equal(u.precioEstado,'desconocido');
 assert.equal(u.precio,null);
 assert.throws(()=>canonicalInput(base({precioInfo:{estado:'desconocido',cantidad:0}})),/unknown_price_has_amount/);
 assert.throws(()=>canonicalInput(base({precioInfo:{estado:'desde'}})),/price_amount_required/);
 const g=canonicalInput(base({precioInfo:{estado:'gratis'}}));
 assert.equal(g.precioEstado,'gratis');assert.equal(g.precio,0);
 const r=canonicalInput(base({precioInfo:{estado:'rango',cantidad:5,cantidadMax:12,moneda:'EUR',textoOriginal:'5-12 €'}}));
 assert.equal(r.precio,5);assert.equal(r.precioDetalle.cantidadMax,12);
 const legacy=canonicalInput(base({precio:0}));
 assert.equal(legacy.precioEstado,'desconocido');
 assert.equal(legacy.precio,null,'legacy 0 must not persist as a readable zero next to desconocido');
});
test('temporalidad: sesiones map to local fields, periodo_venta never creates sessions',()=>{
 const e=canonicalInput(base({fechaLocal:undefined,horaLocal:undefined,sesionId:'s-x',temporalidad:{tipo:'sesiones',sesiones:[{fecha_local:'2027-06-01',hora_local:'19:30',zona:'Europe/Madrid'}],texto_original:'1 de junio a las 19:30'}}));
 assert.equal(e.fechaLocal,'2027-06-01');
 assert.equal(e.horaLocal,'19:30');
 assert.equal(e.temporalidadTexto,'1 de junio a las 19:30');
 assert.throws(()=>canonicalInput(base({temporalidad:{tipo:'periodo_venta',textoOriginal:'entradas junio'}})),/sales_window_not_session/);
 assert.throws(()=>canonicalInput(base({sesionId:undefined,temporalidad:{tipo:'sesiones',sesiones:[{fecha_local:'2027-06-01'},{fecha_local:'2027-06-02'}]}})),/multiple_sessions_split_calls/);
});
test('ubicacion estructurada y categorías v1 validadas',()=>{
 const e=canonicalInput(base({ubicacion:{municipio:'Málaga',provincia:'Málaga',pais:'ES',lugar:'Teatro Ejemplo'},categorias:['Cultura','Música y festivales'],tipo:'evento'}));
 assert.equal(e.city,'Málaga');assert.equal(e.lugar,'Teatro Ejemplo');assert.equal(e.provincia,'Málaga');assert.equal(e.pais,'ES');
 assert.deepEqual(e.categorias,['Cultura','Música y festivales']);assert.equal(e.categoria,'Cultura');
 assert.throws(()=>canonicalInput(base({categorias:['Inventada']})),/unknown_category/);
 assert.throws(()=>canonicalInput(base({ubicacion:{municipio:'Ronda'}})),/conflicting_location/);
});
test('global duplicate lookup crosses businesses and sees capturados, retirados and legacy rows',async()=>{
 const store=new MemoryStore(),events=svc(store);
 const a=await events.create(base({origen:{proveedor:'fever',id_externo:'dup-1',id_sesion:'s1'}}),owner);
 await events.create(base({negocioId:'bizB',titulo:'Otro plan',sesionId:'s-b',fuentes:[{url:'https://example.org/other'}]}),owner);
 store.rows.set('eventos/legacy1',{data:{nombre:'Concierto de prueba',fecha_inicio:'2027-05-10',ciudad:'Málaga',enlace_original:'https://example.org/event'},updateTime:'9'});
 store.rows.get('eventos/'+a.eventId).data.retirado=false;
 const r=await events.findDuplicates({titulo:'Concierto de prueba',city:'Málaga',fechaLocal:'2027-05-10',urls:['https://example.org/event'],origen:{proveedor:'fever',id_externo:'dup-1',id_sesion:'s1'}},owner);
 const byId=Object.fromEntries(r.coincidencias.map(c=>[c.eventId,c.motivos]));
 assert.ok(byId[a.eventId].includes('reserva_origen_exacta'));
 assert.ok(byId[a.eventId].includes('url_fuente'));
 assert.ok(byId['legacy1'].includes('titulo_fecha_lugar'));
 assert.ok(byId['legacy1'].includes('url_fuente'));
 assert.ok(!('dup-otro' in byId));
 assert.equal(r.exhaustivo,true);
 const other=r.coincidencias.find(c=>c.titulo==='Otro plan');
 assert.equal(other,undefined);
});
test('staging keeps incomplete candidates out of the public catalog with idempotent retries',async()=>{
 const store=new MemoryStore(),events=svc(store);
 const c=await events.saveCandidate({titulo:'Taller sin fecha',carencias:['sin fecha verificada','sin precio'],fuentes:[{url:'https://example.org/taller'}],requestId:'cand-1',datos:'{"json":"original"}'},owner);
 assert.equal(c.created,true);
 assert.equal(c.estado,'pendiente');
 const again=await events.saveCandidate({titulo:'Taller sin fecha',carencias:['sin fecha verificada','sin precio'],fuentes:[{url:'https://example.org/taller'}],requestId:'cand-1',datos:'{"json":"original"}'},owner);
 assert.equal(again.alreadyCreated,true);
 await assert.rejects(events.saveCandidate({titulo:'Completo',carencias:[],fuentes:[{url:'https://example.org/x'}]},owner),/carencias_required/);
 await assert.rejects(events.saveCandidate({titulo:'Inseguro',carencias:['x'],fuentes:[{url:'http://insecure.org/x'}]},owner),/https_required|invalid_url/);
 const list=await events.listCandidates({estado:'pendiente'},owner);
 assert.equal(list.candidatos.length,1);
 const d=await events.discardCandidate({candidatoId:c.candidatoId,motivo:'fuente retirada'},owner);
 assert.equal(d.estado,'descartado');
 await assert.rejects(events.discardCandidate({candidatoId:c.candidatoId,motivo:'otra vez'},owner),/already_discarded/);
 const ev=await store.list('eventos',{});
 assert.equal(ev.length,0,'staging must never write to eventos');
});
test('identity with origen stays stable across title and time corrections',()=>{
 const a=canonicalInput(base({origen:{proveedor:'fever',id_externo:'st-1',id_sesion:'ses-1'}}));
 const b=canonicalInput(base({titulo:'Nombre corregido',horaLocal:'18:00',origen:{proveedor:'fever',id_externo:'st-1',id_sesion:'ses-1'}}));
 assert.equal(eventIdentity(a),eventIdentity(b));
 const c=canonicalInput(base({origen:{proveedor:'fever',id_externo:'st-1',id_sesion:'ses-2'}}));
 assert.notEqual(eventIdentity(a),eventIdentity(c));
});
