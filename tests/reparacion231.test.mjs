import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError,normalizeText,canonicalInput } from '../event-domain.mjs';
import { HistoricalFixtureService as EventService } from './helpers/historical-fixtures.mjs';

const owner={id:'conchi',actions:['*'],businesses:['*']};
const base=(overrides={})=>({negocioId:'bizA',titulo:'Concierto de prueba',descripcion:'Evento de la fuente para el ensayo.',city:'Málaga',fechaLocal:'2027-05-10',horaLocal:null,timeZone:'Europe/Madrid',sesionId:'fuente-sesion-A',fuentes:[{url:'https://example.org/event',checkedAt:'2026-10-28T07:00:00Z'}],...overrides});
class MemoryStore {
 constructor(){this.rows=new Map([['negocios/bizA',{data:{nombre:'A'},updateTime:'1'}],['negocios/bizB',{data:{nombre:'B'},updateTime:'2'}]]);this.audit=new Map();this.seq=2;}
 async get(c,id){const r=this.rows.get(c+'/'+id);return r?{id,...structuredClone(r)}:null;}
 async list(c,{business,cursor,limit}={}){let out=[...this.rows].filter(([key,r])=>key.startsWith(c+'/')&&!key.includes('/revisiones/')&&(!business||r.data.negocioId===business)).map(([key,r])=>({id:key.split('/').at(-1),...structuredClone(r)}));out.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);if(cursor)out=out.filter(r=>r.id>=cursor);if(limit)out=out.slice(0,limit);return out;}
 async write(c,id,data,{updateTime,create,audit,request,reserve}={}){const key=c+'/'+id,current=this.rows.get(key);if((create&&current)||(!create&&updateTime&&current?.updateTime!==updateTime)||(request&&this.rows.has('amalia_event_requests/'+request.id))||(reserve&&this.rows.has('amalia_event_reservations/'+reserve.id)))throw new DomainError('version_conflict');const r={data:structuredClone(data),updateTime:String(++this.seq)};this.rows.set(key,r);if(audit)this.audit.set(id,[...(this.audit.get(id)||[]),structuredClone(audit)]);if(request)this.rows.set('amalia_event_requests/'+request.id,{data:request.data,updateTime:String(this.seq)});if(reserve)this.rows.set('amalia_event_reservations/'+reserve.id,{data:reserve.data,updateTime:String(this.seq)});return {id,...r};}
 async revisions(id){return this.audit.get(id)||[];}
}
const mediaStub={persist:async()=>{throw new Error('no media in test');},get:()=>{throw new Error('no media in test');}};
const svc=store=>new EventService(store,mediaStub);

test('normalizeText removes diacritics and case for search keys',()=>{
 assert.equal(normalizeText('Jornada Micológica  en  MÁLAGA'),'jornada micologica en malaga');
 assert.equal(normalizeText('Baño de Bosque'),'bano de bosque');
 assert.equal(normalizeText('  Sainte  Cécile '),'sainte cecile');
});

test('diacritic-only differences no longer hide duplicates',async()=>{
 const store=new MemoryStore(),events=svc(store);
 store.rows.set('eventos/legacy1',{data:{nombre:'Jornada micologica en Villanueva del Conde',fecha_inicio:'2026-11-07',ciudad:'Villanueva del Conde'},updateTime:'9'});
 const r=await events.findDuplicates({titulo:'Jornada micológica en Villanueva del Conde',city:'Villanueva del Conde',fechaLocal:'2026-11-07'},owner);
 const hit=r.coincidencias.find(c=>c.eventId==='legacy1');
 assert.ok(hit,'stored doc without accents must match a query with accents');
 assert.ok(hit.motivos.includes('titulo_fecha_lugar'));
 assert.equal(hit.confianza,'exacta');
});

test('paginacion con cursor inclusivo cubre todos los documentos sin saltarse ninguno',async()=>{
 const store=new MemoryStore(),events=svc(store);
 const N=1203;
 for(let i=0;i<N;i++)store.rows.set(`eventos/ev${String(i).padStart(6,'0')}`,{data:{titulo:'Plan repetido',fechaLocal:'2027-05-10',city:'Málaga'},updateTime:'1'});
 const r=await events.findDuplicates({titulo:'Plan repetido',city:'Málaga',fechaLocal:'2027-05-10',limite:5000},owner);
 assert.equal(r.coincidencias.length,N,'todo documento coincidente debe aparecer: cobertura completa');
 assert.equal(r.exhaustivo,true);
 assert.ok(r.escaneados>=N);
 const corto=await events.findDuplicates({titulo:'Plan repetido',city:'Málaga',fechaLocal:'2027-05-10',limite:300},owner);
 assert.equal(corto.exhaustivo,false,'limite por debajo del total debe declararse no exhaustivo');
 assert.ok(corto.coincidencias.length<N);
});

test('precio legacy 0 sin precioInfo ya no se interpreta gratis ni persiste 0 junto a desconocido',async()=>{
 const e=canonicalInput(base({precio:0}));
 assert.equal(e.precioEstado,'desconocido');
 assert.equal(e.precio,null);
 const explicito=canonicalInput(base({precio:0,precioInfo:{estado:'desconocido'}}));
 assert.equal(explicito.precioEstado,'desconocido');
 assert.equal(explicito.precio,null,'precioInfo desconocido prevalece sobre precio 0 y anula el número');
 const gratis=canonicalInput(base({precio:0,precioInfo:{estado:'gratis'}}));
 assert.equal(gratis.precioEstado,'gratis');
 assert.equal(gratis.precio,0,'gratis explícito sí conserva 0');
 const diez=canonicalInput(base({precio:10}));
 assert.equal(diez.precioEstado,'precio');
 assert.equal(diez.precio,10);
});

test('una edición ajena al precio no reescribe los campos de precio almacenados',async()=>{
 const store=new MemoryStore(),events=svc(store);
 store.rows.set('eventos/legacy0',{data:{titulo:'Ruta de senderismo',descripcion:'Descripción suficiente.',city:'Málaga',negocioId:'bizA',fechaLocal:'2027-05-10',horaLocal:null,timeZone:'Europe/Madrid',sesionId:'s-9',fuentes:[{url:'https://example.org/ruta',checkedAt:null,sourceId:null}],link:'https://example.org/ruta',lugar:'Málaga',precio:0,verificationStatus:'capturado',conflictos:[],version:1,fechaCreacion:'2026-11-01T00:00:00Z',createdBy:'old',metrics:{views:0,clicks:0,interactions:0}},updateTime:'5'});
 const r=await events.update({eventId:'legacy0',negocioId:'bizA',expectedVersion:1,changes:{descripcion:'Descripción suficiente y corregida.'},reason:'corrección de texto'},owner);
 assert.equal(r.precio,0,'sin cambio explícito de precio, el valor almacenado se conserva intacto');
 assert.equal(r.precioEstado,undefined,'no se inventa un estado en una edición ajena');
 const stored=await store.get('eventos','legacy0');
 assert.equal(stored.data.precio,0);
 assert.ok(!('precioEstado' in stored.data));
});

test('la corrección explícita con precioInfo desconocido anula el número y queda auditada',async()=>{
 const store=new MemoryStore(),events=svc(store);
 store.rows.set('eventos/legacy0',{data:{titulo:'Ruta de senderismo',descripcion:'Descripción suficiente.',city:'Málaga',negocioId:'bizA',fechaLocal:'2027-05-10',horaLocal:null,timeZone:'Europe/Madrid',sesionId:'s-9',fuentes:[{url:'https://example.org/ruta',checkedAt:null,sourceId:null}],link:'https://example.org/ruta',lugar:'Málaga',precio:0,verificationStatus:'capturado',conflictos:[],version:1,fechaCreacion:'2026-11-01T00:00:00Z',createdBy:'old',metrics:{views:0,clicks:0,interactions:0}},updateTime:'5'});
 const r=await events.update({eventId:'legacy0',negocioId:'bizA',expectedVersion:1,changes:{precioInfo:{estado:'desconocido'}},reason:'precio 0 sin evidencia de gratuidad'},owner);
 assert.equal(r.precioEstado,'desconocido');
 assert.equal(r.precio,null,'precioInfo desconocido anula el número, no conserva 0 ambiguo');
 const stored=await store.get('eventos','legacy0');
 assert.equal(stored.data.precio,null);
 assert.equal(stored.data.precioEstado,'desconocido');
 assert.equal((await store.revisions('legacy0')).at(-1).reason,'precio 0 sin evidencia de gratuidad');
});

