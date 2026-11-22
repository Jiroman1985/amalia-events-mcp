import test from 'node:test';
import assert from 'node:assert/strict';
import {escanearDuplicados} from '../dedup_amalia.mjs';
const URL_PAG='https://www.aytosalamanca.es/w/programacion-semanal';
const maria={id:'ev_maria',data:{titulo:'María de la Flor',fechaLocal:'2026-11-05',horaLocal:'19:00',city:'Salamanca',lugar:'Biblioteca Torrente Ballester',sesionId:'maria-0511',fuentes:[{url:URL_PAG}]}};
const cand=(over={})=>({negocioId:'b',titulo:'Re.Cuerda',city:'Salamanca',lugar:'Biblioteca Torrente Ballester',fechaLocal:'2026-11-07',horaLocal:'18:30',sesionId:'recuerda-0711',fuentes:[{url:URL_PAG}],...over});
const ids=r=>r.coincidencias.map(c=>c.eventId);
test('dos eventos distintos con la misma URL: la URL es informativa y no bloquea',()=>{
 const r=escanearDuplicados(cand(),[maria]);
 assert.deepEqual(r.coincidencias,[]);
 assert.equal(r.informativas[0].eventId,'ev_maria');assert.equal(r.informativas[0].confianza,'informativa');
 assert.deepEqual(r.informativas[0].motivos,['url_fuente_otra_sesion']);
 assert.equal(r.exhaustivo,true);
});
test('duplicado real con la misma URL sigue bloqueado',()=>{
 const r=escanearDuplicados(cand({titulo:'María de la Flor',fechaLocal:'2026-11-05',horaLocal:'19:00',sesionId:'maria-0511'}),[maria]);
 assert.ok(ids(r).includes('ev_maria'));assert.deepEqual(r.informativas,[]);
});
test('sourceId compartido entre unidades distintas también es informativo',()=>{
 const m={id:'ev_m',data:{...maria.data,fuentes:[{url:'https://a.example/1',sourceId:'prog-1'}]}};
 const r=escanearDuplicados(cand({fuentes:[{url:'https://a.example/2',sourceId:'prog-1'}]}),[m]);
 assert.deepEqual(r.coincidencias,[]);assert.equal(r.informativas.length,1);
});
test('la reserva de origen exacta sigue bloqueando aunque la URL sea solo informativa',async()=>{
 const {originKey}=await import('../dedup_amalia.mjs');
 const origen={proveedor:'p',id_externo:'1',id_sesion:'1'};
 const r=escanearDuplicados(cand({origen}),[maria],{reservas:[{id:originKey(origen),eventId:'ev_maria'}]});
 assert.deepEqual(ids(r),['ev_maria']);assert.ok(r.coincidencias[0].motivos.includes('reserva_origen_exacta'));
 assert.equal(r.coincidencias[0].confianza,'exacta');
});
