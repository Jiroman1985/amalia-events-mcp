import test from 'node:test';import assert from 'node:assert/strict';
import {escanearDuplicados} from '../dedup_amalia.mjs';import {canonicalInput} from '../event-domain.mjs';
const source=url=>[{url}];const previous={id:'ev_al',data:{titulo:'La francesa Laura',city:'Almagro',fechaLocal:'2026-11-14',horaLocal:'20:30',sesionId:'2026-11-14/20:30',sesionExplicita:false,fuentes:source('https://example.org/almagro')}};
const make=(patch={})=>canonicalInput({negocioId:'b1',titulo:'Granada Brass Quintet',descripcion:'Concierto',city:'Rute',fechaLocal:'2026-11-14',horaLocal:'20:30',fuentes:source('https://example.org/rute'),...patch});
test('mismo horario implícito en distinta ciudad y título es informativo',()=>{let r=escanearDuplicados(make(),[previous]);assert.deepEqual(r.coincidencias,[]);assert.equal(r.informativas[0].motivos[0],'sesion_horario_otra_actividad');});
test('candidatos y registros con idéntica fuente y título siguen bloqueados',()=>{let c=make({titulo:'La francesa Laura',city:'Almagro',fuentes:source('https://example.org/almagro')});assert.ok(escanearDuplicados(c,[previous]).coincidencias.length>0)});
test('búsqueda y admisión clasifican igual la sesión implícita de otra ciudad',async()=>{
 const {EventService}=await import('../event-service.mjs');
 const store={get:async()=>null,list:async(c,{cursor,limit}={})=>c==='eventos'&&!cursor?[previous].slice(0,limit):[]};
 const service=new EventService(store,{}),owner={id:'t',actions:['*'],businesses:['*']},c=make();
 const found=await service.findDuplicates({titulo:c.titulo,city:c.city,fechaLocal:c.fechaLocal,horaLocal:c.horaLocal,urls:c.fuentes.map(x=>x.url)},owner);
 const fromAdmission=escanearDuplicados(c,[previous]);assert.deepEqual(found.coincidencias.map(x=>x.eventId),fromAdmission.coincidencias.map(x=>x.eventId));assert.deepEqual(found.informativas.map(x=>x.eventId),fromAdmission.informativas.map(x=>x.eventId));
});
