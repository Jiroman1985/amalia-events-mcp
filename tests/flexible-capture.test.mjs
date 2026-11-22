import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalInput,eventIdentity,record} from '../event-domain.mjs';
const base={negocioId:'bizA',titulo:'Actividad cultural',descripcion:'Una actividad documentada.',city:'Madrid',fechaLocal:'2026-11-20',fuentes:[{url:'https://example.org/programa'}]};
test('una actividad sin hora, precio, direccion ni imagen conserva lo desconocido y una identidad estable',()=>{
 const event=canonicalInput(base),again=canonicalInput({...base});
 assert.equal(event.horaLocal,null);assert.equal(event.horarioTexto,'Sin hora definida');assert.equal(event.precio,null);assert.equal(event.precioEstado,'desconocido');assert.equal(event.assetId,null);assert.equal(event.image,null);assert.equal(event.sesionExplicita,false);assert.equal(eventIdentity(event),eventIdentity(again));
 const saved=record(event,{id:'test'});assert.equal(saved.hora,null);assert.equal(saved.precio,null);
});
test('actividades distintas no comparten identidad y no se inventa fecha',()=>{
 assert.notEqual(eventIdentity(canonicalInput(base)),eventIdentity(canonicalInput({...base,titulo:'Otra actividad'})));
 assert.notEqual(eventIdentity(canonicalInput(base)),eventIdentity(canonicalInput({...base,fechaLocal:'2026-11-21'})));
 assert.throws(()=>canonicalInput({...base,fechaLocal:undefined}));
});
test('búsqueda por defecto revisa más de 2000 sin ocultar el límite explícito',async()=>{
 const {EventService}=await import('../event-service.mjs');
 const docs=Array.from({length:2101},(_,i)=>({id:`ev${String(i).padStart(5,'0')}`,data:{titulo:i===2100?'Actividad buscada':'Otra',city:'Madrid',fechaLocal:'2026-11-20'}}));
 const store={get:async()=>null,list:async(c,{cursor,limit}={})=>{if(c!=='eventos')return [];return docs.filter(x=>!cursor||x.id>=cursor).slice(0,limit)}};
 const service=new EventService(store,{}),owner={id:'test',actions:['*'],businesses:['*']};
 const full=await service.findDuplicates({titulo:'Actividad buscada',city:'Madrid',fechaLocal:'2026-11-20'},owner);assert.equal(full.exhaustivo,true);assert.ok(full.escaneados>=2101);assert.ok(full.coincidencias.some(x=>x.eventId==='ev02100'));
 const limited=await service.findDuplicates({titulo:'Actividad buscada',city:'Madrid',fechaLocal:'2026-11-20',limite:2000},owner);assert.equal(limited.exhaustivo,false);
});
