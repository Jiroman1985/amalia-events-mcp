import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';
const hark={id:'hark',actions:['admit','read'],businesses:['*']};
class M{constructor(){this.rows=new Map([['negocios/b',{data:{nombre:'B'},updateTime:'1'}],['amalia_catalog_guard/eventos',{data:{epoch:0},updateTime:'g'}]]);}
 async get(c,id){const r=this.rows.get(c+'/'+id);return r?{id,...structuredClone(r)}:null;}
 async list(c){return [...this.rows].filter(([k])=>k.startsWith(c+'/')).map(([k,r])=>({id:k.split('/').at(-1),...structuredClone(r)}));}}
test('proposal_changed indica qué campo cambió',async()=>{
 const ev=new EventService(new M(),{get(){throw Error('x')}});
 const base={negocioId:'b',titulo:'Taller de prueba',descripcion:'Descripción original',city:'Soria',provincia:'Provincia de prueba',fechaLocal:'2027-01-10',sesionId:'s1',fuentes:[{url:'https://example.org/a'}],requestId:'r1'};
 const p=await ev.prepareAdmission(base,hark);assert.ok(p.huellaCampos.descripcion);
 try{await ev.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:{...base,descripcion:'Descripción retocada'}},hark);assert.fail('debía fallar');}
 catch(e){assert.equal(e.code,'proposal_changed');const d=Object.keys(p.huellaCampos).filter(k=>p.huellaCampos[k]!==e.details.huellaCampos[k]);assert.deepEqual(d,['descripcion']);}
});
