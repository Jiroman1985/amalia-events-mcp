import {clavesDeEvento,claveSesion,decidirSesion,normalizarUrl,sesionesDeEvento,setAliasDinamico,municipioClave} from './clave-sesion.mjs';
import {encolarRevision,resumenCola} from './cola-revision.mjs';
import {splitProvenance,prepareProvenance,provenanceProposal,assertReplayProvenance,registryCapabilities,registryCutoffConfig,cutoffValue,normalizeProvenance} from './registro-provenance.mjs';
import {ProgramAdmission} from './program-admission.mjs';
import { claveNombre, identidadesCalculadas, escanearDuplicados, informativaPorFuente, motivoSesion, horarioImplicitoDistinto, municipioDistintoAviso, reglaDuplicado, clasificarCoincidencias } from './dedup_amalia.mjs';
import { randomUUID } from 'node:crypto';
import { agenteCanonico } from './identidad.mjs';
import { clasifica, MonitorPlataforma } from './plataforma.mjs';
import { encolar, listar as listarCola, marcar as marcarCola, superaIntentos, resumenPorAgente } from './cola-admision.mjs';
import { publicar as publicarTablon, cerrarAlertaAuto } from './tablon.mjs';
import { listarTareas } from './tareas.mjs';
import { objetivos as objetivosAltas, SIN_ALTAS_MS, ERRORES_REPETIDOS_N, ERRORES_VENTANA_MS, turnoDe, enTurno, minutosLaborables } from './ritmo.mjs';
import { assertAltaCompleta,normSesiones,conPlazo,DomainError,assertFuentePrimaria,mergeSources,tituloSoloForma,canonicalInputExtras,canonicalInput,eventIdentity,fingerprint,record,authorize,authorizeCapture,id,fail,hash,originKey,normalizeText } from './event-domain.mjs';

// Campos opcionales de ficha en candidatos privados: se validan con las mismas reglas que la admisión.
const extrasCandidato=input=>{const {etiquetas,direccion,fuente_nombre,fuente_tipo,fuenteId}=canonicalInputExtras(input);return {...(fuenteId?{fuenteId}:{}),...(etiquetas?{etiquetas}:{}),...(direccion?{direccion}:{}),...(fuente_nombre?{fuente_nombre}:{}),...(fuente_tipo?{fuente_tipo}:{})};};
const leg=(d,k,...alt)=>{for(const key of [k,...alt]){if(d[key]!=null)return d[key];}return null;};
const LOTE_PRESUPUESTO_MS=Number(process.env.AMALIA_LOTE_PRESUPUESTO_MS||38000);
const UNIVERSE_LOAD_MS=Number(process.env.AMALIA_UNIVERSE_LOAD_MS||40000);
// Tope de seguridad SOLO para las herramientas que recorren todo el catálogo (buscar_duplicados_global, programas); la admisión ya no lo usa.
const UNIVERSE_MAX_DOCS=Number(process.env.AMALIA_UNIVERSE_MAX_DOCS||100000);
// Lecturas máximas de listar_altas_recientes por llamada (para calcular `total`); si se alcanzan, totalExacto=false y se sigue con el cursor.
const ALTAS_MAX_LECTURAS=Number(process.env.AMALIA_ALTAS_MAX_LECTURAS||5000);
const UNIVERSE_TTL_MS=Number(process.env.AMALIA_UNIVERSE_TTL_MS||600000);
const ADMISION_INTENTOS=Math.max(1,Number(process.env.AMALIA_ADMISION_INTENTOS||5)),LOTE_ADMISION_MS=Number(process.env.AMALIA_LOTE_ADMISION_MS||45000);
const SLOW_MS=Number(process.env.AMALIA_ADMISION_LENTA_MS||10000),COLA_MS=Number(process.env.AMALIA_COLA_MS||600000),COLA_PRESUPUESTO_MS=Number(process.env.AMALIA_COLA_PRESUPUESTO_MS||40000);
export class EventService {
 constructor(store,media,options={}) {this.clavesModo=options.claves??process.env.AMALIA_CLAVES??'off';this.store=store;this.media=media;this.programs=options.programs||new ProgramAdmission(store);this.inflight=new Map();this.outcomes=new Map();this.registryOptions={...registryCutoffConfig(options.registryCutoff),now:options.now};this.monitor=options.monitor||new MonitorPlataforma();this.resolvePrincipal=options.resolvePrincipal||null;this.colaActiva=options.cola===true;this.plazoLlamadaMs=options.plazoLlamadaMs??Number(process.env.AMALIA_PLAZO_LLAMADA_MS||50000);if(typeof store.listAll==='function'&&options.warm!==false&&this.clavesModo!=='bloquea'){const write=store.write.bind(store);store.write=async(...a)=>{const r=await write(...a);if(a[0]==='eventos'){const patched=await this.patchUniverse(a,r).catch(()=>false);if(!patched)setTimeout(()=>this.warm(),0);}return r;};setTimeout(()=>this.warm(),0);}}
 // Precalienta la caché del catálogo tras cada commit a `eventos`, para que la siguiente preparación no espere la lectura completa.
 // Tras una escritura propia con precondición de guardia (admisión, ediciones con escaneo) nadie más ha escrito entre la guardia leída y este commit:
 // se relee SOLO ese documento y se aplica a la caché en vez de recargar los ~4.000 eventos. Cualquier otra escritura invalida la caché.
 async patchUniverse([collection,key,,opts={}],result){
  const c=this.universeCache,g=opts.guard;
  if(collection!=='eventos'||!c||this.universeLoading||!g?.updateTime||g.updateTime!==c.updateTime||!result?.updateTime)return false;
  const fresh=await this.store.get('eventos',key);
  if(!fresh||fresh.updateTime!==result.updateTime||this.universeCache!==c)return false;
  const docs=c.docs.filter(r=>r.id!==key);docs.push({id:key,data:fresh.data,updateTime:fresh.updateTime});
  let reservas=c.reservas;
  if(opts.moveReserve){reservas=reservas.filter(r=>r.id!==opts.moveReserve.from&&r.id!==opts.moveReserve.to.id);reservas.push({...opts.moveReserve.to.data,id:opts.moveReserve.to.id});}
  if(opts.reserve){reservas=reservas.filter(r=>r.id!==opts.reserve.id);reservas.push({...opts.reserve.data,id:opts.reserve.id});}
  this.universeCache={updateTime:result.updateTime,at:c.at,docs,reservas};
  return true;
 }
 // La admisión ya no necesita precargar el catálogo: consulta solo los candidatos de cada alta.
 warm(){}
 async registryContext(raw,event,principal,opts={}){return prepareProvenance(this.store,raw,event,principal,{cutoff:this.registryOptions.cutoff,degradar:true,rebind:opts.rebind===true,...(this.registryOptions.now?{now:this.registryOptions.now()}: {})});}
 async registryCapabilities(input,principal){return {...await registryCapabilities(this.store,principal,input.fuenteId,this.registryOptions.cutoff),cutoffPorDefecto:this.registryOptions.porDefecto===true};}
 // Recibo por requestId (con o sin negocioId). Si el alta sigue ejecutándose devuelve estado «en_proceso» en vez de un vacío.

 // ---- Fiabilidad: errores de configuración/plataforma no dejan a un agente parado (cola persistente, degradación, salud) ----
 /** Principal interno de las tareas de fondo (reanudar, reconciliar, vigilar). Nunca llega de fuera. */
 get servidor(){return {id:'servidor-amalia',agente:'servidor-amalia',actions:['*'],businesses:['*']};}
 /** Ejecuta una operación de admisión con plazo propio (menor que el de la herramienta): si falla por plataforma/config, el candidato se guarda en la cola del servidor y el agente recibe un resultado normal «encolado». */
 async conCola(accion,original,principal,fn,{plazoMs}={}){
  const op=accion==='preparar'?'preparar':'admitir',t0=Date.now(),agente=agenteCanonico(principal.id);
  try{const r=await conPlazo(fn(),plazoMs??this.plazoLlamadaMs,'operation_timeout',{operacion:accion}),ms=Date.now()-t0;this.monitor.latencia(op,ms);if(ms>SLOW_MS)console.error(JSON.stringify({level:'warn',event:'admision_lenta',operacion:accion,ms}));return r;}
  catch(e){
   const c=clasifica(e);if(!c.reintentable)throw e;
   this.monitor.error(agente,c.codigo,accion);
   if(!this.colaActiva||!original||typeof original!=='object'||Array.isArray(original))throw e;
   let q;try{q=await encolar(this.store,{principal,evento:original,motivo:c.codigo,detalle:e instanceof DomainError?{...e.details,ayuda:undefined}:null});}catch{throw e;}
   console.error(JSON.stringify({level:'warn',event:'alta_encolada',agente,colaId:q.colaId,motivo:c.codigo,operacion:accion}));
   return {encolado:true,estado:'encolado',colaId:q.colaId,requestId:q.requestId,motivo:c.codigo,...(accion==='preparar'?{admisible:false}:{created:false}),ayuda:`Fallo de plataforma (${c.codigo}), no de tus datos. NO esperes aviso: la alta ha quedado en la cola del servidor y se reanudará sola (cada ${Math.round(COLA_MS/60000)} min, o con reanudar_cola_admision cuando salud_admision esté operativa). Sigue preparando la siguiente.`};
  }
 }
 /** Estado de cada dependencia de la admisión (solo lectura). `operativa` = se puede admitir ahora; `estado` verde/amarillo/rojo resume. */
 async salud(principal){
  authorize(principal,null,'read');
  const ahora=Date.now(),cfg=this.registryOptions;let valor=null,valido=false;try{valor=cutoffValue(cfg.cutoff);valido=true;}catch{/* mal formado o ausente */}
  const cutoff={estado:valido&&!cfg.porDefecto?'verde':'amarillo',configurado:valido,porDefecto:cfg.porDefecto===true,valor,efecto:valido?(cfg.porDefecto?'Usa el corte por defecto: define AMALIA_FUENTES_V2_DESDE_ISO.':'Procedencia de registro operativa.'):'Corte inválido: las altas con procedenciaRegistro entran SIN procedencia (procedenciaPendiente=true) hasta que se arregle.'};
  let guardia;try{const g=await this.store.get('amalia_catalog_guard','eventos'),ok=g?.updateTime&&Number.isSafeInteger(g.data.epoch)&&g.data.epoch>=0;guardia=!ok?{estado:'rojo',error:'catalog_guard_unavailable'}:{estado:g.data.admissionPaused===true?'rojo':'verde',epoch:g.data.epoch,admissionPaused:g.data.admissionPaused===true,...(g.data.admissionPaused===true?{error:'admission_paused'}:{})};}
  catch(e){guardia={estado:'rojo',error:clasifica(e).codigo};}
  const uc=this.universeCache,docs=uc?uc.docs.length:null,universo={estado:this.universeLoading||(docs!=null&&docs>UNIVERSE_MAX_DOCS*0.9)?'amarillo':'verde',documentos:docs,limiteDocumentos:UNIVERSE_MAX_DOCS,cacheEdadMs:uc?ahora-uc.at:null,cargando:Boolean(this.universeLoading),ttlMs:UNIVERSE_TTL_MS,limiteCargaMs:UNIVERSE_LOAD_MS},claves={estado:['off','sombra','bloquea'].includes(this.clavesModo)?'verde':'amarillo',modo:this.clavesModo,valido:['off','sombra','bloquea'].includes(this.clavesModo)};
  let cola={estado:'verde',pendientes:0,porAgente:{}};try{const f=await listarCola(this.store,{estado:'pendiente',limite:5000});cola={estado:f.length?'amarillo':'verde',pendientes:f.length,porAgente:resumenPorAgente(f)};}catch(e){cola={estado:'amarillo',error:clasifica(e).codigo};}
  const err2h=this.monitor.erroresDesde(2*3600*1000),hayErr=Object.keys(err2h).length>0;
  const estados=[cutoff.estado,guardia.estado,universo.estado,claves.estado,cola.estado,hayErr?'amarillo':'verde'];
  return {estado:estados.includes('rojo')?'rojo':estados.includes('amarillo')?'amarillo':'verde',operativa:guardia.estado!=='rojo',generadoEn:new Date(ahora).toISOString(),dependencias:{cutoff,guardiaCatalogo:guardia,universo,modoClaves:claves},latenciaMs:{preparar:this.monitor.resumenLatencia('preparar'),admitir:this.monitor.resumenLatencia('admitir')},erroresPlataforma2h:err2h,cola,nota:'Un error de plataforma no es «espera aviso»: el servidor encola el candidato y lo reanuda solo. Consulta esta herramienta al arrancar cada tanda.'};
 }
 async listarCola({estado='pendiente',agente=null,limite=50}={},principal){
  authorize(principal,null,'admit');const admin=principal.actions.includes('*')||agenteCanonico(principal.id)==='alfred';
  const filas=await listarCola(this.store,{estado,agente:admin?agente:agenteCanonico(principal.id),limite:Math.min(Math.max(Number(limite)||50,1),200)});
  return {total:filas.length,items:filas.map(({evento,updateTime,...f})=>({...f,evento:{titulo:evento?.titulo,fechaLocal:evento?.fechaLocal,city:evento?.city}}))};
 }
 #principalDe(fila,llamador){return fila.principal===llamador.id?llamador:(this.resolvePrincipal?.(fila.principal)||null);}
 /** Representa y admite lo encolado cuando la salud lo permite. Idempotente por requestId (el alta ya creada no se duplica) y respeta el escaneo de duplicados (es la admisión normal). */
 async reanudarCola({limite=10,agente=null,presupuestoMs=COLA_PRESUPUESTO_MS}={},principal){
  authorize(principal,null,'admit');
  const admin=principal.actions.includes('*')||agenteCanonico(principal.id)==='alfred',filtro=admin?agente:agenteCanonico(principal.id);
  if(this.reanudando)return {reanudadas:0,motivo:'ya_en_curso'};
  this.reanudando=true;
  try{
   const salud=await this.salud(this.servidor);
   if(!salud.operativa)return {reanudadas:0,motivo:'salud_no_operativa',guardiaCatalogo:salud.dependencias.guardiaCatalogo};
   const filas=await listarCola(this.store,{estado:'pendiente',agente:filtro,limite:Math.min(Math.max(Number(limite)||10,1),50)});
   const out={revisadas:filas.length,reanudadas:0,omitidasDuplicado:0,rechazadas:0,siguenPendientes:0,resultados:[]},porAgente={},inicio=Date.now();
   for(const f of filas){
    if(Date.now()-inicio>presupuestoMs){out.siguenPendientes++;out.resultados.push({colaId:f.colaId,estado:'pendiente',motivo:'presupuesto_agotado'});continue;}
    const p=this.#principalDe(f,principal),nota=(estado,extra={})=>{out.resultados.push({colaId:f.colaId,titulo:f.titulo,estado,...extra});(porAgente[f.agente]||=[]).push({estado,titulo:f.titulo,...extra});};
    if(!p){out.siguenPendientes++;out.resultados.push({colaId:f.colaId,estado:'pendiente',motivo:'principal_desconocido'});continue;}
    try{
     const prep=await this.prepareAdmission({...f.evento,requestId:f.requestId},p,{rebind:true});
     if(prep.admissionPaused){out.siguenPendientes++;out.resultados.push({colaId:f.colaId,estado:'pendiente',motivo:'admission_paused'});continue;}
     if(!prep.admisible){await marcarCola(this.store,f,{estado:'omitida_duplicado',coincidencias:prep.coincidencias||null,resueltaEn:new Date().toISOString()});out.omitidasDuplicado++;nota('omitida_duplicado',{coincidencias:(prep.coincidencias||[]).map(c=>c.eventId).filter(Boolean)});continue;}
     const r=await this.admitCandidate({accion:'admit',proposalHash:prep.proposalHash,evento:prep.evento},p,{rebind:true});
     if(r.multiple&&!r.completo){await marcarCola(this.store,f,{intentos:(f.intentos||0)+1,ultimoIntentoEn:new Date().toISOString()});out.siguenPendientes++;out.resultados.push({colaId:f.colaId,estado:'pendiente',motivo:'lote_incompleto'});continue;}
     await marcarCola(this.store,f,{estado:'reanudada',eventId:r.eventId||null,resueltaEn:new Date().toISOString(),intentos:(f.intentos||0)+1});out.reanudadas++;nota('reanudada',{eventId:r.eventId||null});
    }catch(e){
     const c=clasifica(e),intentos=(f.intentos||0)+1;
     if(c.reintentable){this.monitor.error(f.agente,c.codigo,'reanudar');await marcarCola(this.store,f,{intentos,ultimoIntentoEn:new Date().toISOString(),ultimoMotivo:c.codigo,...(superaIntentos(intentos)?{estado:'bloqueada'}:{})});out.siguenPendientes++;out.resultados.push({colaId:f.colaId,estado:superaIntentos(intentos)?'bloqueada':'pendiente',motivo:c.codigo});}
     else{await marcarCola(this.store,f,{estado:'rechazada',codigo:c.codigo,detalle:e instanceof DomainError?e.details||null:null,resueltaEn:new Date().toISOString(),intentos});out.rechazadas++;nota('rechazada',{codigo:c.codigo});}
    }
   }
   await this.#avisarReanudacion(porAgente);
   return out;
  }finally{this.reanudando=false;}
 }
 /** Una nota en el tablón para cada agente afectado y para Alfred con lo reanudado (de mejor esfuerzo: nunca rompe la reanudación). */
 async #avisarReanudacion(porAgente){
  for(const [agente,lista] of Object.entries(porAgente)){
   const n=k=>lista.filter(x=>x.estado===k).length,texto=`La cola de admisión del servidor ha procesado ${lista.length} alta(s) de ${agente}: ${n('reanudada')} admitidas, ${n('omitida_duplicado')} omitidas por posible duplicado, ${n('rechazada')} rechazadas por datos.`+(lista.slice(0,5).map(x=>`\n- ${x.estado}: ${x.titulo||'(sin título)'}${x.codigo?' ('+x.codigo+')':''}`).join(''));
   try{await publicarTablon(this.store,{tipo:'aviso',asunto:`Cola de admisión: ${lista.length} alta(s) de ${agente} procesadas`,texto:texto.slice(0,1900),destinatarios:[...new Set([agente,'alfred'])],prioridad:'normal'},this.servidor);}catch(e){console.error(JSON.stringify({level:'warn',event:'aviso_cola_fallido',agente,error:e?.code||'error'}));}
  }
 }
 /** Adjunta la procedencia a los eventos admitidos sin ella (procedenciaPendiente=true) cuando la configuración vuelve. Los errores de datos los dejan pendientes y se informan. */
 async reconciliarProcedencias({limite=50,simular=false}={},principal){
  if(!(principal.actions.includes('*')||principal.actions.includes('review')||agenteCanonico(principal.id)==='alfred'))authorize(principal,null,'review');
  try{cutoffValue(this.registryOptions.cutoff);}catch{return {reconciliadas:0,motivo:'registro_cutoff_unconfigured',ayuda:'El corte sigue sin ser válido: define AMALIA_FUENTES_V2_DESDE_ISO (ISO 8601 con zona).'};}
  const filas=await this.store.list('eventos',{eq:{procedenciaPendiente:true},limit:Math.min(Math.max(Number(limite)||50,1),200)});
  const out={revisadas:filas.length,reconciliadas:0,bloqueadasPorDatos:[],simulado:simular===true},now=new Date().toISOString(),interno=this.servidor;
  for(const f of filas){
   const d=f.data||{};if(d.procedenciaPendiente!==true||!d.procedenciaPendienteDatos)continue;
   try{
    const ctx=await prepareProvenance(this.store,d.procedenciaPendienteDatos,{negocioId:d.negocioId,fuentes:d.fuentes},interno,{cutoff:this.registryOptions.cutoff,rebind:true,...(this.registryOptions.now?{now:this.registryOptions.now()}:{})});
    if(!ctx||ctx.degradada)continue;
    if(!simular)await this.store.write('eventos',f.id,{procedenciaRegistro:ctx.record,procedenciaPendiente:false,procedenciaPendienteMotivo:null,procedenciaPendienteDatos:null,procedenciaReconciliadaEn:now,procedenciaReconciliadaPor:agenteCanonico(principal.id)},{updateTime:f.updateTime,updateFields:['procedenciaRegistro','procedenciaPendiente','procedenciaPendienteMotivo','procedenciaPendienteDatos','procedenciaReconciliadaEn','procedenciaReconciliadaPor'],metadataOnly:true});
    out.reconciliadas++;
   }catch(e){out.bloqueadasPorDatos.push({eventId:f.id,error:e instanceof DomainError?e.code:'operation_failed'});}
  }
  return out;
 }

 // ---- Vigilancia de ritmo: altas por agente contra su objetivo y alertas automáticas en el tablón ----
 async #altasVentana(desdeMs){
  const iso=new Date(desdeMs).toISOString(),out=[];
  const acepta=(id,x)=>{if(!x||x.retirado===true||x.prueba===true||!x.fechaCreacion)return;const t=Date.parse(x.fechaCreacion);if(Number.isFinite(t)&&t>=desdeMs)out.push({eventId:id,agente:agenteCanonico(x.agenteCanonico||x.createdBy||''),t});};
  if(typeof this.store.queryPagina==='function'){
   let despues=null;
   for(let leidos=0;;){const page=await this.store.queryPagina('eventos','fechaCreacion',{desde:iso,hasta:null,despues,desc:true,limit:500});leidos+=page.length;for(const r of page)acepta(r.id,r.data);if(page.length<500||leidos>=ALTAS_MAX_LECTURAS)break;const l=page.at(-1);despues={valor:l.data.fechaCreacion,id:l.id};}
  }else{const u=await this.catalogUniverse();for(const r of u.docs)acepta(r.id,r.data);}
  return out;
 }
 async #alertasAbiertas(){
  const filas=await this.store.list('tablon_agentes',{eq:{alerta_auto:true,estado:'abierto'},limit:200}),m=new Map();
  for(const f of filas)if(f.data?.alerta_clave&&f.data.estado==='abierto')m.set(f.data.alerta_clave,f.id);
  return m;
 }
 /** Solo lectura: altas por agente en la última hora y 24 h contra su objetivo, cola pendiente con su motivo, tareas en curso, errores recientes y alertas abiertas. */
 async ritmoAltas(principal,{ahora=Date.now()}={}){
  authorize(principal,null,'read');
  const objs=objetivosAltas(),altas=await this.#altasVentana(ahora-24*3600*1000),cola=resumenPorAgente(await listarCola(this.store,{estado:'pendiente',limite:5000})),abiertas=await this.#alertasAbiertas();
  const nombres=[...new Set([...Object.keys(objs),...altas.map(a=>a.agente).filter(Boolean),...Object.keys(cola)])].sort(),agentes=[];
  for(const agente of nombres){
   const mias=altas.filter(a=>a.agente===agente),h1=mias.filter(a=>a.t>=ahora-3600*1000).length,ult=mias.reduce((m,a)=>Math.max(m,a.t),0)||null,obj=objs[agente]||null;
   const turno=turnoDe(obj),min=ult==null?null:Math.floor((ahora-ult)/60000),minLab=minutosLaborables(ult??ahora-24*3600*1000,ahora,turno);
   const tareas=obj?(await listarTareas(this.store,{agente,estado:'en_curso'},this.servidor).catch(()=>({total:0}))).total:0;
   const estado=!obj?'sin_objetivo':minLab>=SIN_ALTAS_MS()/60000?'parado':mias.length<obj.min?'por_debajo':mias.length>obj.max?'por_encima':'en_objetivo';
   agentes.push({agente,altasUltimaHora:h1,altasUltimas24h:mias.length,ultimaAltaEn:ult?new Date(ult).toISOString():null,minutosSinAltas:min,minutosSinAltasEnTurno:minLab,turno:obj?`${turno.desde}-${turno.hasta} (hora de Madrid)`:null,enTurnoAhora:obj?enTurno(ahora,turno):null,objetivo:obj?{minimoDia:obj.min,maximoDia:obj.max,porHoraEfectiva:Math.ceil(obj.min/obj.horasEfectivas)}:null,avanceMinimoDiaPct:obj?Math.round(mias.length/Math.max(1,obj.min)*100):null,estado,colaPendiente:cola[agente]||{pendientes:0,motivos:{}},tareasEnCurso:tareas,erroresPlataforma2h:this.monitor.erroresDesde(2*3600*1000,{agente}),alertasAbiertas:[...abiertas.keys()].filter(k=>k.split(':')[1]===agente)});
  }
  return {generadoEn:new Date(ahora).toISOString(),ventana:'24 h (las altas retiradas y de prueba no cuentan)',sinAltasAlertaTrasMinEnTurno:SIN_ALTAS_MS()/60000,agentes,colaTotalPendiente:Object.values(cola).reduce((a,c)=>a+c.pendientes,0)};
 }
 /** Una vuelta de vigilancia: abre (una sola por agente y asunto) y cierra solas las alertas del tablón. Alfred: agente con objetivo >2 h sin altas con cola o tareas en curso; error de config/plataforma repetido 3 veces en 15 min (esperaA inaki: es del servidor). */
 async vigilar({ahora=Date.now()}={}){
  const r=await this.ritmoAltas(this.servidor,{ahora}),abiertas=await this.#alertasAbiertas(),debidas=new Map(),fueraDeTurno=new Set();
  for(const a of r.agentes){
   if(a.objetivo&&a.estado==='parado'&&(a.colaPendiente.pendientes>0||a.tareasEnCurso>0)){
    const h=String(Math.floor(a.minutosSinAltasEnTurno/60));
    if(a.enTurnoAhora!==true)fueraDeTurno.add('ritmo:'+a.agente);
    debidas.set('ritmo:'+a.agente,{asunto:`Ritmo: ${a.agente} lleva ${h} h de turno sin altas`,texto:`${a.agente} tiene objetivo de ${a.objetivo.minimoDia}-${a.objetivo.maximoDia} altas/día y lleva ${h} h de turno (${a.turno}) sin dar ninguna (${a.altasUltimas24h} en 24 h). Cola de admisión pendiente: ${a.colaPendiente.pendientes}${Object.keys(a.colaPendiente.motivos||{}).length?' ('+Object.entries(a.colaPendiente.motivos).map(([k,n])=>k+' '+n).join(', ')+')':''}; tareas en curso: ${a.tareasEnCurso}. Mira ritmo_altas y salud_admision. La alerta se cierra sola cuando vuelva a dar altas.`,servidor:false});
   }
  }
  const n=ERRORES_REPETIDOS_N(),vent=ERRORES_VENTANA_MS();
  for(const agente of this.monitor.agentesConErrores(vent))for(const codigo of this.monitor.codigosDe(agente,vent)){
   const veces=this.monitor.repeticiones(agente,codigo,vent);
   if(veces>=n)debidas.set(`error:${agente}:${codigo}`,{asunto:`Error repetido: ${codigo} (${agente}) ${veces} veces en ${Math.round(vent/60000)} min`,texto:`El servidor ha devuelto ${codigo} a ${agente} ${veces} veces en ${Math.round(vent/60000)} min. Es un fallo de configuración o de plataforma, no de datos: las altas quedan en la cola del servidor y se reanudan solas, pero hay que revisar la causa. Mira salud_admision. La alerta se cierra sola cuando deje de repetirse.`,servidor:true});
  }
  const out={abiertas:[],cerradas:[]};
  for(const [clave,d] of debidas){
   if(abiertas.has(clave)||fueraDeTurno.has(clave))continue; // fuera de turno no se abren alertas de ritmo (las abiertas siguen hasta que se resuelva la causa)
   try{const p=await publicarTablon(this.store,{tipo:'ayuda',asunto:d.asunto.slice(0,120),texto:d.texto.slice(0,1900),destinatarios:['alfred'],prioridad:'urgente',...(d.servidor?{esperaA:'inaki'}:{})},this.servidor,{extra:{alerta_auto:true,alerta_clave:clave}});out.abiertas.push({clave,hilo:p.id});console.error(JSON.stringify({level:'warn',event:'alerta_abierta',clave}));}
   catch(e){console.error(JSON.stringify({level:'warn',event:'alerta_fallida',clave,error:e?.code||'error'}));}
  }
  for(const [clave,id] of abiertas){
   if(debidas.has(clave))continue;
   try{if(await cerrarAlertaAuto(this.store,id,'Resuelta sola: la condición que la abrió ya no se da.'))out.cerradas.push({clave,hilo:id});}catch{/* se reintenta en la siguiente vuelta */}
  }
  return out;
 }
 async registryAdmissionReceipt({negocioId,requestId},principal){
  if(typeof requestId!=='string'||!requestId||requestId.length>128)fail('invalid_request_id');
  if(negocioId)authorize(principal,negocioId,'read');
  const keyOf=n=>'req_'+hash(principal.id+'\0'+n+'\0'+requestId).slice(0,40);
  let candidates=negocioId?[negocioId]:[];
  if(!negocioId){const rows=await this.store.list('eventos',{requestId,limit:20});candidates=[...new Set(rows.filter(r=>r.data?.requestId===requestId&&r.data.negocioId).map(r=>r.data.negocioId))];}
  for(const n of candidates){
   const row=await this.store.get('amalia_event_requests',keyOf(n));
   if(!row)continue;
   if(row.data.actor!==principal.id||row.data.negocioId!==n)fail('business_forbidden');
   authorize(principal,n,'read');
   const evento=await this.get(row.data.eventId,n,principal);
   return {requestId,estado:'guardado',negocioId:n,eventId:row.data.eventId,provenanceHash:row.data.provenanceHash??null,evento,readOnly:true};
  }
  const live=this.inflight.get(principal.id+'\0'+requestId);
  if(live&&(!negocioId||live.negocioId===negocioId))return {requestId,estado:'en_proceso',negocioId:live.negocioId,desde:live.desde,ayuda:'La admisión sigue ejecutándose en el servidor. Vuelve a consultar en unos segundos; no la repitas con otro requestId.',readOnly:true};
  const out=this.outcomes.get(principal.id+'\0'+requestId);
  if(out&&(!negocioId||out.negocioId===negocioId)&&Date.now()-Date.parse(out.en)<6*3600e3)return {requestId,estado:out.estado,codigo:out.codigo,negocioId:out.negocioId,en:out.en,coincidencias:out.coincidencias,eventId:out.eventId,ayuda:out.estado==='contended'?'Hubo escrituras simultáneas y no se guardó nada. Vuelve a preparar_admision y admite de nuevo con el mismo requestId.':'No se guardó: hay una coincidencia que exige revisión. Revisa las coincidencias; no repitas la admisión tal cual.',readOnly:true};
  fail('admission_receipt_not_found',{requestId,ayuda:'No hay evento guardado ni admisión en curso con ese requestId (para este agente).'});
 }
 async business(businessId) {const b=await this.store.get('negocios',id(businessId));if(!b)fail('business_not_found');return b;}
 async prepare(input,principal) {
  authorize(principal,input.negocioId,'create');await this.business(input.negocioId);
  if(input.image && !input.assetId){const asset=await this.media.persist({url:input.image,sourceUrl:input.link || input.fuentes?.[0]?.url || input.image,negocioId:input.negocioId,rights:input.imageRights || {status:'unknown'}},principal);input={...input,assetId:asset.id,sourceImageUrl:input.image,image:asset.url};}
  if(input.assetId){const asset=this.media.get(input.assetId,input.negocioId,principal);input={...input,image:asset.url,sourceImageUrl:asset.sourceUrl};}
  return canonicalInput(input);
 }
 async create() {fail('direct_creation_disabled',{use:'preparar_admision y admitir_candidato'});}
 async #createAdmitted(input,principal,guard,program=null,registry=null,extra={}) {
  authorize(principal,input.negocioId,'admit');
  const requestKey=input.requestId ? 'req_'+hash(principal.id+'\0'+input.negocioId+'\0'+input.requestId).slice(0,40) : null;
  const requestFingerprint=fingerprint(input);
  if(requestKey){const prior=await this.store.get('amalia_event_requests',requestKey);if(prior){if(prior.data.fingerprint!==requestFingerprint)fail('idempotency_conflict');assertReplayProvenance(prior.data,registry);return {created:false,alreadyCreated:true,...await this.get(prior.data.eventId,input.negocioId,principal)};}}
  const e=program?.event||await this.canonicalForAdmission(input,principal),eventId=eventIdentity(e),creationFingerprint=program?.creationFingerprint||fingerprint(e),existing=await this.store.get('eventos',eventId);
  if(existing){assertReplayProvenance(existing.data,registry);authorize(principal,existing.data.negocioId,'read');if(existing.data.retirado===true)fail('event_retired',{eventId});if(existing.data.creationFingerprint!==creationFingerprint)fail('duplicate_event_conflict',{eventId,version:existing.data.version});return {created:false,alreadyCreated:true,eventId,...existing.data};}
  let reserve=null;
  if(e.origen){
   const rk=originKey(e.origen),priorRow=await this.store.get('amalia_event_reservations',rk),prior=this.reservaActiva(priorRow)?priorRow:null;
   if(prior){
    if(prior.data.eventId===eventId){const same=await this.store.get('eventos',eventId);if(same){assertReplayProvenance(same.data,registry);authorize(principal,same.data.negocioId,'read');return {created:false,alreadyCreated:true,eventId,...same.data};}}
    fail('duplicate_event_conflict',{eventId:prior.data.eventId,reservaOrigen:rk,revision:true});
   }
   reserve={id:rk,...(priorRow&&!prior?{updateTime:priorRow.updateTime}:{}),data:{eventId,negocioId:e.negocioId,origen:e.origen,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,at:new Date().toISOString()}};
  }
  const claves=this.clavesModo==='off'?null:await this.planClaves(eventId,null,extra.discriminadorSesion?{...e,discriminadorSesion:extra.discriminadorSesion}:e);
  const r={...record(e,principal),...(extra.discriminadorSesion?{discriminadorSesion:extra.discriminadorSesion}:{}),...program?.record,...(registry?(registry.degradada?{procedenciaPendiente:true,procedenciaPendienteMotivo:registry.motivo,procedenciaPendienteDatos:registry.datos,provenanceHash:registry.hash}:{procedenciaRegistro:registry.record,provenanceHash:registry.hash}):{}),creationFingerprint,requestId:input.requestId || null,...(input.confirmarOtraSesion&&!program?{confirmacionOtraSesion:{eventIds:[...new Set(input.confirmarOtraSesion.eventIds)].sort(),motivo:input.confirmarOtraSesion.motivo,evidenciaUrl:input.confirmarOtraSesion.evidenciaUrl,por:principal.id,en:new Date().toISOString()}}:{})};
  try {await this.store.write('eventos',eventId,r,{create:true,guard,claves,verifies:[...(program?.verifies||[]),...(registry&&!registry.degradada?[registry.verify]:[])],extras:program?.extras,audit:{version:1,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,action:'created',at:r.fechaCreacion,after:r},request:requestKey?{id:requestKey,data:{eventId,fingerprint:requestFingerprint,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,negocioId:e.negocioId,...(registry?{provenanceHash:registry.hash}: {})}}:undefined,reserve});}
  catch(error){if(error.code==='version_conflict'){
   const now=await this.store.get('eventos',eventId);
   if(now?.data.creationFingerprint===creationFingerprint){assertReplayProvenance(now.data,registry);return {created:false,alreadyCreated:true,eventId,...now.data};}
   if(reserve){const held=await this.store.get('amalia_event_reservations',reserve.id);if(this.reservaActiva(held)&&held.data.eventId!==eventId)fail('duplicate_event_conflict',{eventId:held.data.eventId,reservaOrigen:reserve.id,revision:true});}
   if(claves&&this.clavesModo==='bloquea')await this.conflictoClave([...claves.crear,...claves.actualizar],eventId);
   }throw error;}
  if(this.clavesModo!=='off')this.registrarAlias(e.city).catch(()=>{});
  return {created:true,eventId,...r};
 }
 async canonicalForAdmission(input,principal) {
  authorize(principal,input.negocioId,'read');await this.business(input.negocioId);
  if(input.verificationStatus && input.verificationStatus!=='capturado')fail('admission_requires_capturado');
  if(input.image&&!input.assetId)fail('image_requires_saved_asset');
  if(input.assetId){const asset=this.media.get(input.assetId,input.negocioId,principal);input={...input,image:asset.url,sourceImageUrl:asset.sourceUrl};}
  assertAltaCompleta(input);
  const canon=canonicalInput({...input,verificationStatus:'capturado'});
  assertFuentePrimaria(canon.fuentes);
  if(canon.prueba===true){
   // Fixtures never reach the map, but they still reserve identities and match duplicate searches: keep them in their own namespace.
   authorize(principal,input.negocioId,'admit_test');
   if(!principal.actions.includes('*')){
   if(!/^\[PRUEBA\]/.test(canon.titulo))fail('test_event_title_prefix',{ayuda:'Un evento de prueba debe empezar su titulo por "[PRUEBA] " para no chocar con eventos reales.'});
   if(canon.origen&&!/^prueba-/.test(canon.origen.proveedor))fail('test_event_origin_prefix',{ayuda:'En un evento de prueba, origen.proveedor debe empezar por "prueba-" (por ejemplo prueba-claude) para no reservar identidades reales.'});
   }
  }
  return canon;
 }
 /**
  * Universo ACOTADO para comprobar duplicados de UN candidato: no lee el catálogo. Consulta (índice de campo único) los eventos con fecha de sesión
  * entre -1 y +1 día de cada sesión del candidato, sin los ya pasados, y los limita al mismo municipio o provincia; además lecturas puntuales
  * de la identidad calculada y de la reserva de origen. La guardia se lee ANTES de las consultas: si alguien escribe después, el commit falla por contienda.
  * Una sola consulta por ventana, sobre fechaLocal: el backfill normalizó los eventos antiguos (los que no tienen ninguna fecha utilizable no podían coincidir por fecha). Todo escritor debe rellenar fechaLocal.
  */
 async candidateUniverse(e,{requireOpen=false}={}) {
  const guard=await this.catalogGuard({requireOpen});
  await this.cargarAlias();
  const hoy=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Madrid'});
  const dia=(f,n)=>{const t=new Date(f+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
  const fechas=[...new Set([e.fechaLocal,...(Array.isArray(e.sesiones)?e.sesiones.map(s=>s.fechaLocal):[])].filter(f=>/^\d{4}-\d{2}-\d{2}$/.test(f||'')))].sort();
  const ventanas=[];
  for(const f of fechas){const lo=dia(f,-1)<hoy?hoy:dia(f,-1),hi=dia(f,1);if(hi<hoy)continue;const ult=ventanas.at(-1);if(ult&&lo<=dia(ult.hi,1))ult.hi=hi>ult.hi?hi:ult.hi;else ventanas.push({lo,hi});}
  const porId=new Map(),add=r=>{if(r?.id&&!porId.has(r.id))porId.set(r.id,r);};
  const rango=async(campo,lo,hi)=>typeof this.store.queryRango==='function'?this.store.queryRango('eventos',campo,lo,hi):this.#rangoEnMemoria(campo,lo,hi);
  for(const v of ventanas){
   for(const r of await rango('fechaLocal',v.lo,v.hi))add(r);
  }
  for(const id of identidadesCalculadas(e))add(await this.store.get('eventos',id));
  // Misma URL de origen en cualquier fecha: lectura indexada (igualdad sobre link y enlace_original), para detectar un reingreso con la fecha mal leída fuera de la ventana.
  const urlsOrigen=[...new Set([...(e.fuentes||[]).map(s=>s?.url),e.link].filter(u=>typeof u==='string'&&u))].slice(0,10),porUrl=new Set();
  for(const u of urlsOrigen)for(const campo of ['link','enlace_original'])for(const r of await this.store.list('eventos',{eq:{[campo]:u},limit:50}))if(r.data?.[campo]===u){add(r);porUrl.add(r.id);}
  const reservas=[];
  if(e.origen){
   const held=await this.store.get('amalia_event_reservations',originKey(e.origen));
   if(held&&held.data.estado!=='liberada'){reservas.push({...held.data,id:held.id});if(held.data.eventId)add(await this.store.get('eventos',held.data.eventId));}
  }
  const muni=municipioClave(e.city||''),prov=claveNombre(e.provincia||'');
  const mismoLugar=r=>{const d=r.data||{},c=leg(d,'city','ciudad')||(typeof d.ubicacion==='string'?d.ubicacion:d.ubicacion?.municipio),p=claveNombre(d.provincia||(d.ubicacion&&d.ubicacion.provincia)||'');
   if(!muni||!c)return true;if(municipioClave(c)===muni)return true;return !!(prov&&p&&p===prov);};
  const idsFijos=new Set([...identidadesCalculadas(e),...reservas.map(r=>r.eventId),...porUrl]);
  const docs=[...porId.values()].filter(r=>idsFijos.has(r.id)||mismoLugar(r));
  return {guard,docs,reservas};
 }
 // Almacenes sin consulta por rango (dobles de prueba): se recorre por páginas, sin tope, y se filtra en memoria con el mismo criterio.
 async #rangoEnMemoria(campo,lo,hi) {
  const out=[];let cursor=null;
  for(;;){const page=await this.store.list('eventos',{cursor,limit:500});if(!Array.isArray(page))fail('incomplete_scan');for(const r of page){const v=r.data?.[campo];if(typeof v==='string'&&v>=lo&&v<=hi)out.push(r);}if(page.length<500)return out;cursor=page.at(-1).id;}
 }
 async catalogUniverse({requireOpen=false}={}) {
  const guard=await this.store.get('amalia_catalog_guard','eventos');
  if(!guard?.updateTime || !Number.isSafeInteger(guard.data.epoch) || guard.data.epoch<0 || guard.data.epoch>=Number.MAX_SAFE_INTEGER)fail('catalog_guard_unavailable');
  if(requireOpen && guard.data.admissionPaused===true)fail('admission_paused');
  const readAll=async(collection,limit=Infinity)=>{
   const out=[],seen=new Set();let cursor=null;
   for(;;){
    const rows=await this.store.list(collection,{cursor,limit:500});
    if(!Array.isArray(rows)||rows.length>500)fail('incomplete_scan');
    for(const row of rows){if(!row?.id||seen.has(row.id))fail('incomplete_scan');seen.add(row.id);out.push(row);if(out.length>limit)fail('catalog_limit_exceeded');}
    if(rows.length<500)return out;
    cursor=rows.at(-1).id;
   }
  };
  // El universo se reutiliza mientras la guardia no cambie: todo commit a `eventos` (MCP y writers externos) la mueve (contrato de guardia). El tope de edad cubre escrituras que no la respeten.
  const c=this.universeCache;
  if(c&&c.updateTime===guard.updateTime&&Date.now()-c.at<UNIVERSE_TTL_MS)return {guard,docs:c.docs,reservas:c.reservas};
  // Nunca dos cargas a la vez (el pico de memoria se duplicaría): si hay una en curso se espera a que acabe y se revalida.
  if(this.universeLoading){
   const loading=this.universeLoading;
   const u=await conPlazo(loading.promise,UNIVERSE_LOAD_MS,'catalog_load_timeout',{ayuda:'La lectura del catálogo tardó demasiado y se abandonó; reintenta en unos segundos.'});
   if(loading.updateTime===guard.updateTime)return {guard,...u};
   return this.catalogUniverse({requireOpen});
  }
  this.universeCache=null;
  const loadAll=async(collection,limit)=>typeof this.store.listAll==='function'?this.store.listAll(collection,{max:limit}):readAll(collection,limit);
  const promise=conPlazo((async()=>({docs:await loadAll('eventos',UNIVERSE_MAX_DOCS),reservas:(await loadAll('amalia_event_reservations')).filter(r=>r.data.estado!=='liberada').map(r=>({...r.data,id:r.id}))}))(),UNIVERSE_LOAD_MS,'catalog_load_timeout',{ayuda:'La lectura del catálogo tardó demasiado y se abandonó; reintenta en unos segundos.'});
  this.universeLoading={updateTime:guard.updateTime,promise};
  try{const u=await promise;this.universeCache={updateTime:guard.updateTime,at:Date.now(),...u};return {guard,...u};}
  finally{if(this.universeLoading?.promise===promise)this.universeLoading=null;}
 }
 /** Ficha con varias sesiones: además de la comprobación normal (primera sesión), cada sesión adicional se comprueba contra el catálogo como si fuese un alta propia. */
 scanFicha(e,universe,confirmar=null){
  const base=this.scanAdmission(e,universe,confirmar);
  if(!Array.isArray(e.sesiones)||e.sesiones.length<2)return base;
  const propio=eventIdentity(e),coincidencias=[...base.coincidencias],informativas=[...(base.informativas||[])];
  for(const ses of e.sesiones.slice(1)){
   const sub=this.scanAdmission({...e,fechaLocal:ses.fechaLocal,horaLocal:ses.horaLocal,fechaFinLocal:null},universe,confirmar);
   for(const c of sub.coincidencias)if(c.eventId!==propio&&!coincidencias.some(x=>x.eventId===c.eventId))coincidencias.push({...c,sesion:ses.fechaLocal});
   for(const c of sub.informativas||[])if(c.eventId!==propio&&!informativas.some(x=>x.eventId===c.eventId))informativas.push({...c,sesion:ses.fechaLocal});
  }
  return {...base,coincidencias,informativas};
 }
 scanAdmission(e,universe,confirmar=null) {
  // Test fixtures (prueba:true) never reach the map: they only count as duplicates for other test fixtures, so a trial run cannot block the real event.
  const docs=e.prueba===true?universe.docs:universe.docs.filter(r=>(r.data||r).prueba!==true);
  let scan=escanearDuplicados(e,docs,{limite:Infinity,reservas:universe.reservas});
  // A reservation remains authoritative after its event has been purged.
  if(e.origen){const held=universe.reservas.find(r=>r.id===originKey(e.origen));if(held&&!universe.docs.some(r=>r.id===held.eventId))scan.coincidencias.push({eventId:held.eventId||null,motivos:['reserva_huerfana'],confianza:'exacta'});}
  if(!scan.exhaustivo)fail('incomplete_scan');
  if(confirmar)scan=this.confirmarOtraSesion(e,scan,universe,confirmar);
  scan.coincidencias.sort((a,b)=>a.eventId<b.eventId?-1:a.eventId>b.eventId?1:0);
  return scan;
 }
 // El agente acredita que la misma página de fuente publica otra sesión distinta (otro día, otro sesionId explícito).
 // Solo rebaja «url_fuente_otra_sesion»/«source_id_otra_sesion» de los eventos nombrados; cualquier otro motivo sigue bloqueando.
 confirmarOtraSesion(e,scan,universe,c) {
  const SOLO=new Set(['url_fuente_otra_sesion','source_id_otra_sesion','url_titulo']),host=u=>{try{return new URL(u).hostname.toLowerCase().replace(/^www\./,'');}catch{return null;}};
  const ids=[...new Set(c.eventIds||[])];
  if(!ids.length)fail('confirm_not_applicable',{ayuda:'confirmarOtraSesion.eventIds no puede estar vacío.'});
  if(e.sesionExplicita!==true)fail('confirm_requires_explicit_session',{ayuda:'Pasa un sesionId estable y propio de esta sesión (por ejemplo la fecha o el id de la ficha).'});
  if(!e.fecha&&!e.fechaLocal)fail('confirm_not_applicable',{ayuda:'La sesión nueva necesita fechaLocal.'});
  if(!c.evidenciaUrl||!/^https:\/\//.test(c.evidenciaUrl)||host(c.evidenciaUrl)!==host(e.fuentes[0].url))fail('confirm_evidence_invalid',{ayuda:'evidenciaUrl debe ser https y del mismo sitio que la primera fuente, y mostrar ambas fechas.'});
  const rest=[],ok=[];
  for(const x of scan.coincidencias){
   if(!ids.includes(x.eventId)){rest.push(x);continue;}
   const d=(universe.docs.find(r=>r.id===x.eventId)||{}).data||{},dF=d.fechaLocal||d.fecha_inicio||null;
   // Mismo día pero municipio distinto (p. ej. un circuito con una pieza por pueblo): cuenta como otra sesión; «titulo_fecha» (mismo título y fecha, ciudad distinta) también se puede confirmar.
   const cA=normalizeText(e.city),cB=normalizeText(leg(d,'city','ciudad')||(typeof d.ubicacion==='string'?d.ubicacion:d.ubicacion?.municipio)),ciudadDistinta=!!(cA&&cB&&cA!==cB);
   const solo=x.motivos.length>0&&x.motivos.every(m=>SOLO.has(m)||(ciudadDistinta&&m==='titulo_fecha'));
   if(!solo||d.retirado===true||d.verificationStatus==='cancelado'||/cancel|retirad/i.test(String(d.estado||''))||!dF||(dF===e.fechaLocal&&!ciudadDistinta)||d.sesionId===e.sesionId)fail('confirm_not_applicable',{eventId:x.eventId,motivos:x.motivos,ayuda:'Solo se confirma una coincidencia que sea únicamente «misma página, otra sesión», de un evento vigente con otra fecha y otro sesionId (o sin sesionId, si es un registro antiguo).'});
   ok.push({...x,confianza:'confirmada_otra_sesion'});
  }
  const faltan=ids.filter(i=>!ok.some(o=>o.eventId===i));
  if(faltan.length)fail('confirm_no_match',{eventIds:faltan,ayuda:'Esos eventos no figuran entre las coincidencias de esta sesión.'});
  return {...scan,coincidencias:rest,informativas:[...(scan.informativas||[]),...ok],confirmadas:ok.map(o=>o.eventId)};
 }
 fieldPrints(e,input) {const out={requestId:fingerprint(input.requestId||null)};for(const k of Object.keys(e).sort())out[k]=fingerprint(e[k]??null).slice(0,12);out.requestId=out.requestId.slice(0,12);return out;}
 proposal(e,input,principal,scan) {const c=input.confirmarOtraSesion;return fingerprint({actor:agenteCanonico(principal.id),actorPrincipal:principal.id,evento:e,requestId:input.requestId||null,coincidencias:scan.coincidencias,...(c?{confirmacion:{eventIds:[...new Set(c.eventIds)].sort(),motivo:c.motivo,evidenciaUrl:c.evidenciaUrl}}:{})});}
 /** Varias sesiones en una sola llamada: se expande en una admisión por sesión (misma ficha, una fecha/hora cada una). null si no es un lote. */
 sesionesLote(original){
  const {content,raw}=splitProvenance(original),t=content.temporalidad;
  if(!t||t.tipo!=='sesiones'||!Array.isArray(t.sesiones)||t.sesiones.length<2)return null;
  if(content.sesionId||content.origen)return null;   // identidad estable: UNA ficha con todas las sesiones
  if(t.sesiones.length>60)fail('too_many_sessions',{maximo:60,recibidas:t.sesiones.length});
  const vistos=new Set();
  const items=t.sesiones.map((ses,i)=>{
   const f=ses.fechaLocal??ses.fecha_local,h=ses.horaLocal??ses.hora_local??null,clave=f+'|'+(h||'');
   if(vistos.has(clave))fail('duplicate_sessions_in_call',{indice:i,fechaLocal:f,horaLocal:h,ayuda:'Dos sesiones de la misma llamada tienen la misma fecha y hora.'});
   vistos.add(clave);
   const evento={...content,temporalidad:{tipo:'sesiones',sesiones:[ses],...(t.textoOriginal!=null?{textoOriginal:t.textoOriginal}:{}),...(t.texto_original!=null?{texto_original:t.texto_original}:{})}};
   if(content.requestId)evento.requestId=String(content.requestId).slice(0,120)+'~'+(i+1);
   return {indice:i+1,fechaLocal:f,horaLocal:h,evento:raw?{...evento,procedenciaRegistro:raw}:evento};
  });
  return items;
 }
 async prepareLote(items,principal,opts={}){
  const sesiones=[];
  for(const it of items){
   const p=await this.prepareAdmission(it.evento,principal,opts);
   sesiones.push({indice:it.indice,fechaLocal:it.fechaLocal,horaLocal:it.horaLocal,eventId:p.eventId,admisible:p.admisible,proposalHash:p.proposalHash,coincidencias:p.coincidencias,informativas:p.informativas,avisos:p.avisos,_p:p});
  }
  return sesiones;
 }
 // ---- Claves canónicas por sesión (sesiones_clave) ----
 // Modo AMALIA_CLAVES: off (sin claves) | sombra (mantiene claves y compara, sin bloquear) | bloquea (decide por claves, sin escaneos completos).
 // Una reserva «liberada» (la cuenta no puede borrar) equivale a no existir.
 reservaActiva(row){return !!row&&row.data.estado!=='liberada'&&!!row.data.eventId;}
 // Alias de municipio aprendidos (colección municipio_alias): se cargan cada 5 min y los lee la clave. Sin alias o sin acceso, solo rige la tabla fija.
 async cargarAlias(){
  if(this.aliasAt&&Date.now()-this.aliasAt<300000)return;this.aliasAt=Date.now();
  try{setAliasDinamico((await this.store.list('municipio_alias',{limit:500})).map(r=>r.data));}catch{}
 }
 /** «A/B» en el municipio de un evento o negocio → alias A↔B guardado una vez (no pisa la tabla fija). Mejor esfuerzo: nunca rompe el alta. */
 async registrarAlias(city,origen='evento'){
  if(typeof city!=='string'||!/[\/|]/.test(city))return null;
  const partes=city.split(/\s*[\/|]\s*/).map(x=>x.trim()).filter(Boolean);if(partes.length<2||partes.length>3)return null;
  const norm=[...new Set(partes.map(p=>claveNombre(p)).filter(Boolean))];if(norm.length<2)return null;
  await this.cargarAlias();if(new Set(norm.map(p=>municipioClave(p))).size===1)return null;
  const aid='ma_'+hash(norm.slice().sort().join('|')).slice(0,24);
  try{await this.store.write('municipio_alias',aid,{partes:norm,original:city.slice(0,120),origen,at:new Date().toISOString()},{create:true});this.aliasAt=0;await this.cargarAlias();return aid;}catch(e){if(e.code==='version_conflict')return aid;return null;}
 }
 async catalogGuard({requireOpen=false}={}) {
  const guard=await this.store.get('amalia_catalog_guard','eventos');
  if(!guard?.updateTime || !Number.isSafeInteger(guard.data.epoch) || guard.data.epoch<0 || guard.data.epoch>=Number.MAX_SAFE_INTEGER)fail('catalog_guard_unavailable');
  if(requireOpen && guard.data.admissionPaused===true)fail('admission_paused');
  return guard;
 }
 async vecinosClaves(municipioFecha){return (await this.store.list('sesiones_clave',{eq:{municipioFecha},limit:500})).filter(r=>r.data.estado!=='liberada'&&r.data.eventId).map(r=>({...r.data,claveId:r.id}));}
 /** Comprobación por claves: consultas por municipio+fecha y lecturas puntuales; nunca recorre el catálogo. */

 async scanPorClaves(e,{eventId=eventIdentity(e)}={}) {
  await this.cargarAlias();
  const claves=clavesDeEvento(eventId,e),cache=new Map(),bloq=new Map(),cola=new Map();
  for(const c of claves){
   let vec=cache.get(c.data.municipioFecha);if(!vec){vec=await this.vecinosClaves(c.data.municipioFecha);cache.set(c.data.municipioFecha,vec);}
   const prueba=e.prueba===true,cand={...c.data,titulo:e.titulo,tituloOriginal:e.titulo};
   const d=decidirSesion(cand,vec.filter(v=>v.eventId!==eventId&&(v.prueba===true)===prueba));
   for(const m of d.motivos){const mapa=m.decision==='bloquea'?bloq:cola,cur=mapa.get(m.eventId)||{eventId:m.eventId,motivos:[],confianza:m.decision==='bloquea'?'exacta':'dudosa',sesion:c.data.fecha};if(!cur.motivos.includes(m.motivo))cur.motivos.push(m.motivo);mapa.set(m.eventId,cur);}
  }
  if(e.origen){const held=await this.store.get('amalia_event_reservations',originKey(e.origen));if(this.reservaActiva(held)&&held.data.eventId!==eventId){const cur=bloq.get(held.data.eventId)||{eventId:held.data.eventId,motivos:[],confianza:'exacta'};cur.motivos.push('reserva_origen_exacta');bloq.set(held.data.eventId,cur);}}
  for(const k of bloq.keys())cola.delete(k);
  const coincidencias=[...bloq.values(),...cola.values()].sort((a,b)=>a.eventId<b.eventId?-1:a.eventId>b.eventId?1:0);
  const decision=bloq.size?'bloquea':cola.size?'cola':'libre';
  return {coincidencias,informativas:[],escaneados:0,exhaustivo:true,claves:{modo:this.clavesModo,decision,calculadas:claves.map(c=>({clave:c.data.clave,fuerza:c.data.fuerza})),consultas:cache.size}};
 }
 async scanAdmisionFicha(e,input,{requireOpen=false}={}) {
  if(this.clavesModo==='bloquea'){
   if(input.confirmarOtraSesion)fail('invalid_field',{campo:'confirmarOtraSesion',ayuda:'Ningún agente puede saltarse un aviso de duplicado. Si crees que es otra sesión distinta, la decisión es de Alfred: queda en la cola revisar_candidatos.'});
   const guard=await this.catalogGuard({requireOpen});
   return {guard,scan:await this.scanPorClaves(e)};
  }
  const universe=await this.candidateUniverse(e,{requireOpen}),scan=this.scanFicha(e,universe,input.confirmarOtraSesion);
  if(this.clavesModo==='sombra'){
   try{const sombra=await this.scanPorClaves(e);scan.clavesSombra={decision:sombra.claves.decision,coincidencias:sombra.coincidencias};console.log(JSON.stringify({event:'claves_sombra',eventId:eventIdentity(e),actual:scan.coincidencias.length?'bloquea':'libre',claves:sombra.claves.decision,coincidenciasClaves:sombra.coincidencias.map(c=>c.eventId)}));}catch(err){console.error(JSON.stringify({event:'claves_sombra_error',error:err?.code||'error'}));}
  }
  return {guard:universe.guard,scan};
 }
 /**
  * Plan de claves de UN evento (nada se borra: la cuenta de servicio no puede). Solo toca claves PROPIAS (eventId igual) o libres/liberadas:
  *  - libera (estado:'liberada', con updateTime) las claves propias del estado anterior que ya no corresponden;
  *  - crea las nuevas (exists:false) o retoma las libres/liberadas/propias (con updateTime);
  *  - una clave activa de OTRO evento: en bloquea error session_key_conflict; en sombra se omite. `toma` = eventIds cuyas claves se pueden heredar (fusión).
  */

 async planClaves(eventId,viejo,nuevo,{estricto=this.clavesModo==='bloquea',toma=[]}={}) {
  await this.cargarAlias();
  const now=new Date().toISOString(),deseadas=nuevo?clavesDeEvento(eventId,nuevo):[],quiero=new Set(deseadas.map(c=>c.id)),filas=new Map();
  const leer=async cid=>{if(!filas.has(cid))filas.set(cid,await this.store.get('sesiones_clave',cid));return filas.get(cid);};
  const ops=new Map();
  if(viejo)for(const c of clavesDeEvento(eventId,viejo)){
   if(quiero.has(c.id))continue;
   const row=await leer(c.id);
   if(row&&row.data.estado!=='liberada'&&row.data.eventId===eventId)ops.set(c.id,{tipo:'actualizar',id:c.id,updateTime:row.updateTime,data:{...row.data,estado:'liberada',eventIdAnterior:eventId,eventId:null,liberadaEn:now}});
  }
  for(const c of deseadas){
   const row=await leer(c.id),datos={...c.data,estado:'activa'};
   if(!row){ops.set(c.id,{tipo:'crear',id:c.id,data:datos});continue;}
   const activa=row.data.estado!=='liberada'&&row.data.eventId,dueno=row.data.eventId;
   if(activa&&dueno!==eventId&&!toma.includes(dueno)){if(estricto)fail('session_key_conflict',{eventId:dueno,clave:row.data.clave,estado:'review_required',ayuda:'Esa sesión (municipio, fecha, hora y recinto) ya existe. Usa el eventId devuelto; si es otra actividad distinta, la decisión es de Alfred (cola revisar_candidatos).'});continue;}
   if(activa&&dueno===eventId&&row.data.titulo===datos.titulo&&row.data.hora===datos.hora&&row.data.recinto===datos.recinto&&row.data.municipioFecha===datos.municipioFecha)continue;
   ops.set(c.id,{tipo:'actualizar',id:c.id,updateTime:row.updateTime,data:datos});
  }
  const lista=[...ops.values()];
  return {crear:lista.filter(o=>o.tipo==='crear').map(({id,data})=>({id,data})),actualizar:lista.filter(o=>o.tipo==='actualizar').map(({id,data,updateTime})=>({id,data,updateTime}))};
 }
 async conflictoClave(claves,eventId) {
  for(const c of claves){const row=await this.store.get('sesiones_clave',c.id);if(row&&row.data.estado!=='liberada'&&row.data.eventId&&row.data.eventId!==eventId)fail('session_key_conflict',{eventId:row.data.eventId,clave:row.data.clave,estado:'review_required',ayuda:'Esa sesión (municipio, fecha, hora y recinto) ya existe. Usa el eventId devuelto; si es otra actividad distinta, la decisión es de Alfred (cola revisar_candidatos).'});}
 }

 aliasIdempotencia(o){if(o&&typeof o==='object'&&'idempotencyKey' in o){const {idempotencyKey,...rest}=o;return rest.requestId||!idempotencyKey?rest:{...rest,requestId:idempotencyKey};}return o;}

 /**
  * Fusiona un duplicado en la ficha conservada en UN solo commit atómico: rellena huecos de la conservada (fuentes, hora, dirección, imagen, fuenteId),
  * MUEVE las sesiones que solo tenía la otra, retira la otra (nunca borra) y traspasa/libera las claves. Si algo cambió entretanto, no se escribe nada.
  * simular=true devuelve el plan completo (campos, sesiones, claves y conflictos) sin escribir.
  */
 async fusionarPar({conservarId,retirarId,motivo,simular=false},principal) {
  authorize(principal,null,'retire');authorize(principal,null,'complete');
  if(typeof motivo!=='string'||motivo.trim().length<3||motivo.length>500)fail('reason_required');
  const k=await this.store.get('eventos',id(conservarId)),o=await this.store.get('eventos',id(retirarId));
  if(!k||!o)fail('event_not_found');if(k.id===o.id)fail('invalid_field',{campo:'retirarId'});
  if(k.data.retirado===true||o.data.retirado===true)fail('event_retired');
  const vacio=v=>v==null||v===''||(Array.isArray(v)&&!v.length),now=new Date().toISOString(),kd=k.data,od=o.data;
  const set={};
  if(Array.isArray(od.fuentes)&&od.fuentes.length){const merged=mergeSources(kd.fuentes,od.fuentes);if(fingerprint(merged)!==fingerprint(kd.fuentes||[]))set.fuentes=merged;}
  if(vacio(kd.horaLocal??kd.hora)&&od.horaLocal)set.horaLocal=od.horaLocal;
  if(vacio(kd.direccion)&&od.direccion)set.direccion=od.direccion;
  if(vacio(kd.image??kd.imagen)&&vacio(kd.assetId)){if(od.assetId)set.assetId=od.assetId;if(od.image&&vacio(kd.image))set.image=od.image;if(od.sourceImageUrl&&vacio(kd.sourceImageUrl))set.sourceImageUrl=od.sourceImageUrl;}
  const fuenteIdMovida=vacio(kd.fuenteId)&&!!od.fuenteId;if(fuenteIdMovida){set.fuenteId=od.fuenteId;set.fuenteIdAnterior=kd.fuenteId??null;}
  const ya=sesionesDeEvento(kd),mover=sesionesDeEvento(od).filter(x=>!ya.some(y=>y.fechaLocal===x.fechaLocal&&(y.horaLocal||null)===(x.horaLocal||null)));
  if(mover.length){authorize(principal,null,'edit');const todas=[...ya,...mover].sort((x,y)=>x.fechaLocal<y.fechaLocal?-1:x.fechaLocal>y.fechaLocal?1:(x.horaLocal||'')<(y.horaLocal||'')?-1:1);set.sesiones=todas;set.fechaLocal=todas[0].fechaLocal;set.fechaFinLocal=todas.at(-1).fechaLocal;}
  const version=(kd.version||0)+1,patchK={...set,version,updatedBy:agenteCanonico(principal.id),updatedByPrincipal:principal.id,fechaActualizacion:now};
  const afterK={...kd,...patchK},vo=od.version||0;
  const patchO={retirado:true,retiradoPor:agenteCanonico(principal.id),retiradoPorPrincipal:principal.id,retiradoEn:now,retiradoMotivo:`Duplicado de ${k.id}: ${motivo.trim()}`,retiradoVersion:vo,estadoAnterior:od.estado??null,activaAnterior:od.activa??null,estado:'retirado',activa:false,version:vo+1,updatedBy:agenteCanonico(principal.id),updatedByPrincipal:principal.id,fechaActualizacion:now};
  let claves=null,conflicto=null;
  if(this.clavesModo!=='off'){
   try{
    const delOtro=await this.planClaves(o.id,od,null),delKeeper=await this.planClaves(k.id,kd,afterK,{toma:[o.id],estricto:this.clavesModo==='bloquea'}),mapa=new Map();
    for(const c of delOtro.actualizar)mapa.set(c.id,{tipo:'actualizar',...c});
    for(const c of delKeeper.actualizar)mapa.set(c.id,{tipo:'actualizar',...c});
    const crear=delKeeper.crear;claves={crear,actualizar:[...mapa.values()].map(({tipo,...c})=>c)};
   }catch(e){if(e.code==='session_key_conflict')conflicto=e.details;else throw e;}
  }
  const plan={conservar:k.id,retirar:o.id,camposAAplicar:Object.keys(set).filter(x=>x!=='fuenteIdAnterior'),sesionesAMover:mover,moverFuenteId:fuenteIdMovida,claves:claves?{crear:claves.crear.map(c=>c.data.clave),actualizar:claves.actualizar.map(c=>c.data.clave||c.id)}:null,conflictoClaves:conflicto,versionConservada:version-1,versionRetirada:vo,atomico:true};
  if(simular)return {simulado:true,escrito:false,...plan,siguientePaso:conflicto?'Hay un conflicto de claves: resuélvelo antes de fusionar.':'Aplica sin simular: una sola operación atómica.'};
  if(conflicto)fail('session_key_conflict',conflicto);
  const audit=(ev,before,patch,action)=>({version:patch.version,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,action,reason:motivo.trim(),at:now,before,after:patch});
  await this.store.writeMany([
   {key:k.id,data:patchK,updateTime:k.updateTime,updateFields:Object.keys(patchK),audit:audit(k,{version:kd.version||0},patchK,'merged_from_duplicate')},
   {key:o.id,data:patchO,updateTime:o.updateTime,updateFields:Object.keys(patchO),audit:audit(o,{retirado:false,version:vo},patchO,'retired')}
  ],{claves,guard:{updateTime:(await this.catalogGuard()).updateTime}});
  return {...plan,escrito:true,retirada:o.id,sesionesMovidas:mover.length};
 }
 async resolverPar(row,{accion,eventIdDestino,motivo,simular},principal) {
  const {a,b}=row.data,res={accion,por:agenteCanonico(principal.id),porPrincipal:principal.id,en:new Date().toISOString(),motivo:motivo.trim()};
  const cierra=async(estado,extra={})=>{await this.store.write('revisar_candidatos',row.id,{...row.data,estado,resolucion:{...res,...extra},version:(row.data.version||1)+1},{updateTime:row.updateTime});};
  if(accion==='admitir_distinta'){if(simular)return {simulado:true,escrito:false,colaId:row.id,efecto:'Marca el par como «son sesiones distintas»: no se toca ninguna ficha.'};await cierra('admitida');return {colaId:row.id,estado:'admitida',nota:'Par confirmado como distinto; no se vuelve a proponer.'};}
  if(accion==='descartar'){if(simular)return {simulado:true,escrito:false,colaId:row.id,efecto:'Descarta la propuesta sin tocar fichas.'};await cierra('descartada');return {colaId:row.id,estado:'descartada'};}
  if(![a,b].includes(eventIdDestino))fail('invalid_field',{campo:'eventIdDestino',validos:[a,b]});
  const retirarId=eventIdDestino===a?b:a,out=await this.fusionarPar({conservarId:eventIdDestino,retirarId,motivo,simular},principal);
  if(simular)return {...out,colaId:row.id};
  await cierra('fusionada',{eventIdDestino,retirada:retirarId});return {colaId:row.id,estado:'fusionada',...out};
 }

 async listarRevision({estado='pendiente',limite=50,cursor}={},principal) {
  authorize(principal,null,'read');
  if(!['pendiente','admitida','fusionada','descartada'].includes(estado))fail('invalid_field',{campo:'estado'});
  const rows=await this.store.list('revisar_candidatos',{estado,cursor,limit:Math.min(Math.max(Number(limite)||50,1),100)});
  return {items:rows.map(resumenCola),siguiente:rows.length>=Math.min(Math.max(Number(limite)||50,1),100)?rows.at(-1).id:null};
 }
 /** Solo Alfred (board_admin). admitir_distinta | fusionar | descartar. simular=true no escribe nada. */
 async resolverRevision({colaId,accion,eventIdDestino,discriminador,motivo,simular=false},principal) {
  authorize(principal,null,'board_admin');
  if(!['admitir_distinta','fusionar','descartar'].includes(accion))fail('invalid_field',{campo:'accion',validos:['admitir_distinta','fusionar','descartar']});
  if(typeof motivo!=='string'||motivo.trim().length<3||motivo.length>500)fail('reason_required');
  const row=await this.store.get('revisar_candidatos',id(colaId));if(!row)fail('review_item_not_found');
  if(row.data.estado!=='pendiente')fail('review_already_resolved',{estado:row.data.estado});
  if(row.data.tipo==='auditoria_par')return this.resolverPar(row,{accion,eventIdDestino,motivo,simular},principal);
  const now=new Date().toISOString(),ev=row.data.evento,res={accion,por:agenteCanonico(principal.id),porPrincipal:principal.id,en:now,motivo:motivo.trim()};
  const cierra=async(estado,extra={})=>{await this.store.write('revisar_candidatos',row.id,{...row.data,estado,resolucion:{...res,...extra},version:(row.data.version||1)+1},{updateTime:row.updateTime});};
  if(accion==='descartar'){if(simular)return {simulado:true,escrito:false,colaId:row.id,efecto:'Se marcaría como descartada; no se crea ninguna ficha.'};await cierra('descartada');return {colaId:row.id,estado:'descartada'};}
  if(accion==='fusionar'){
   if(!eventIdDestino)fail('invalid_field',{campo:'eventIdDestino'});
   const dest=await this.store.get('eventos',id(eventIdDestino));if(!dest)fail('event_not_found',{eventId:eventIdDestino});if(dest.data.retirado===true)fail('event_retired',{eventId:eventIdDestino});
   const campos={},url=ev.fuentes?.[0]?.url;
   if(Array.isArray(ev.fuentes)&&ev.fuentes.length)campos.fuentes=ev.fuentes;
   if(ev.horaLocal&&!(dest.data.horaLocal??dest.data.hora)&&url)campos.horaLocal=ev.horaLocal;
   if(ev.direccion&&!dest.data.direccion)campos.direccion=ev.direccion;
   if(simular)return {simulado:true,escrito:false,colaId:row.id,eventIdDestino,camposAAplicar:Object.keys(campos),efecto:'Rellena solo huecos del existente (completar) y cierra el elemento como fusionado.'};
   const out=await this.complete({eventId:dest.id,negocioId:dest.data.negocioId,expectedVersion:dest.data.version||0,campos,motivo:`Fusión desde cola ${row.id}: ${res.motivo}`,evidenciaUrl:url||null},principal);
   await cierra('fusionada',{eventIdDestino});return {colaId:row.id,estado:'fusionada',eventIdDestino,completado:out.completado,aplicados:out.aplicados};
  }
  // admitir_distinta
  const disc=typeof discriminador==='string'&&discriminador.trim()?discriminador.trim().slice(0,80):'';
  const input={...ev,requestId:'cola-'+row.id};
  // La procedencia se verificó y autorizó al encolar (con el principal que la aportó): aquí se revalida contra el registro con permiso review acotado a esta comprobación.
  const rawProc=row.data.procedenciaRegistro||null,principalProc=rawProc?{...principal,actions:[...new Set([...principal.actions,'review'])]}:principal;
  if(simular){const e=await this.canonicalForAdmission(input,principal);if(rawProc)await this.registryContext(rawProc,e,principalProc);const claves=clavesDeEvento(eventIdentity(e),{...e,discriminadorSesion:disc});return {simulado:true,escrito:false,colaId:row.id,eventId:eventIdentity(e),conProcedenciaRegistro:!!rawProc,claves:claves.map(c=>({clave:c.data.clave,fuerza:c.data.fuerza})),efecto:'Crearía la ficha como sesión distinta con el discriminador indicado.'};}
  const gd=await this.catalogGuard({requireOpen:true});
  let creada,registry=null;
  try{if(rawProc){const e=await this.canonicalForAdmission(input,principal);registry=await this.registryContext(rawProc,e,principalProc);}
   creada=await this.#createAdmitted(input,principal,{updateTime:gd.updateTime,epoch:gd.data.epoch},null,registry,{discriminadorSesion:disc});}
  catch(err){if(err.code==='session_key_conflict'&&!disc)fail('discriminador_required',{...err.details,ayuda:'La clave de sesión coincide con otra ficha: indica un discriminador (sala, actividad) que las distinga.'});throw err;}
  await cierra('admitida',{eventId:creada.eventId,discriminador:disc||null});
  return {colaId:row.id,estado:'admitida',eventId:creada.eventId,created:creada.created};
 }

 async prepareAdmission(original,principal,opts={}) {
  original=this.aliasIdempotencia(original);
  const lote=this.sesionesLote(original);
  if(lote){
   const ses=await this.prepareLote(lote,principal,opts),admisibles=ses.filter(x=>x.admisible).length;
   return {multiple:true,accionRequerida:'admit',sesionesTotal:ses.length,admisibles,bloqueadas:ses.length-admisibles,admisible:admisibles>0,proposalHash:hash(JSON.stringify(ses.map(x=>[x.indice,x.eventId,x.proposalHash]))),sesiones:ses.map(({_p,...x})=>x),evento:original,nota:'Cada sesión se comprueba contra duplicados por separado. Al admitir con este mismo hash se crean las admisibles y se omiten las bloqueadas (salen con su motivo). Repetir la llamada es seguro: las ya creadas no se duplican.',persistido:false};
  }
  const {content:input,raw}=splitProvenance(original);
  if(input.programa)return this.prepareProgramAdmission(original,principal);
  const e=await this.canonicalForAdmission(input,principal),{guard:gd,scan}=await this.scanAdmisionFicha(e,input),registry=await this.registryContext(raw,e,principal,opts);
  return {accionRequerida:'admit',proposalHash:provenanceProposal(this.proposal(e,input,principal,scan),registry),huellaCampos:this.fieldPrints(e,input),eventId:eventIdentity(e),admisible:scan.coincidencias.length===0&&gd.data.admissionPaused!==true,admissionPaused:gd.data.admissionPaused===true,candidato:e,evento:registry?{...input,procedenciaRegistro:registry.input}:input,...scan,persistido:false};
 }
 async admitCandidate(args,principal,opts={}) {
  if(args&&args.evento)args={...args,evento:this.aliasIdempotencia(args.evento)};
  const lote=this.sesionesLote(args.evento);if(lote)return this.admitLote(args,lote,principal,opts);
  const rid=splitProvenance(args.evento).content?.requestId,nid=splitProvenance(args.evento).content?.negocioId,mark=rid&&typeof rid==='string'?principal.id+'\0'+rid:null;
  if(mark)this.inflight.set(mark,{negocioId:nid,desde:new Date().toISOString()});
  try{const r=await this.admitCandidateInner(args,principal,opts);if(r?.created===true)this.monitor.alta(agenteCanonico(principal.id));return r;}
  catch(e){
   // El error de siempre (compatibilidad con los scripts) + estado explícito y un recibo consultable: «review_required» (coincidencia que exige revisión humana) o «contended» (escrituras simultáneas, repreparar).
   if(e instanceof DomainError&&['duplicate_event_conflict','admission_contended','session_key_conflict','requires_review'].includes(e.code)){
    const estado=e.code==='admission_contended'?'contended':'review_required';
    e.details={...e.details,estado,...(rid?{requestId:rid}:{})};
    if(mark){this.outcomes.set(mark,{estado,codigo:e.code,negocioId:nid,en:new Date().toISOString(),coincidencias:e.details.coincidencias||null,eventId:e.details.eventId||null});while(this.outcomes.size>500)this.outcomes.delete(this.outcomes.keys().next().value);}
   }
   throw e;
  }
  finally{if(mark)this.inflight.delete(mark);}
 }
 async admitLote({accion,proposalHash,evento},items,principal,opts={}){
  authorize(principal,splitProvenance(evento).content.negocioId,'admit');
  if(accion!=='admit'||typeof proposalHash!=='string'||!/^[a-f0-9]{64}$/.test(proposalHash))fail('explicit_admission_required');
  const ses=await this.prepareLote(items,principal,opts),actual=hash(JSON.stringify(ses.map(x=>[x.indice,x.eventId,x.proposalHash])));
  if(actual!==proposalHash)fail('proposal_changed',{repreparar:true,ayuda:'Algo cambió desde preparar_admision (catálogo o datos). Vuelve a preparar y usa el nuevo hash.'});
  const inicio=Date.now(),resultados=[];let creadas=0,yaExistian=0,omitidas=0,errores=0,pendientes=0;
  for(const [k,x] of ses.entries()){
   const base={indice:x.indice,fechaLocal:x.fechaLocal,horaLocal:x.horaLocal};
   if(!x.admisible){omitidas++;resultados.push({...base,estado:'omitida_duplicado',coincidencias:x.coincidencias});continue;}
   if(Date.now()-inicio>LOTE_PRESUPUESTO_MS){pendientes++;resultados.push({...base,estado:'pendiente'});continue;}
   try{const r=await this.admitCandidate({accion:'admit',proposalHash:x.proposalHash,evento:items[k].evento},principal,opts);
    if(r.alreadyCreated){yaExistian++;resultados.push({...base,estado:'ya_existia',eventId:r.eventId});}else{creadas++;resultados.push({...base,estado:'creada',eventId:r.eventId});}}
   catch(e){errores++;resultados.push({...base,estado:'error',error:e instanceof DomainError?e.code:'operation_failed',...(e instanceof DomainError?{detalle:e.details}:{})});}
  }
  return {multiple:true,sesionesTotal:ses.length,creadas,yaExistian,omitidas,errores,pendientes,completo:pendientes===0&&errores===0,resultados,...(pendientes?{aviso:'Se agotó el tiempo de la llamada: repite la misma llamada (mismo hash); las creadas no se duplican y se continúa con las pendientes.'}:{})};
 }
 async admitCandidateInner({accion,proposalHash,evento:original,huellaCampos},principal,opts={}) {
  const {content:evento,raw}=splitProvenance(original);
  authorize(principal,evento.negocioId,'admit');
  if(accion!=='admit'||typeof proposalHash!=='string'||!/^[a-f0-9]{64}$/.test(proposalHash))fail('explicit_admission_required');
  if(evento.programa)return this.admitProgramCandidate({proposalHash,evento:original},principal);
  const input=evento,e=await this.canonicalForAdmission(input,principal),eventId=eventIdentity(e);
  return this.#enSerie(async()=>{
  let represado=null;
  for(let attempt=0;attempt<ADMISION_INTENTOS;attempt++) {
   let registry;
   try{registry=await this.registryContext(raw,e,principal,opts);}
   catch(err){
    // Otra alta de la misma fuente movió la versión del documento de la fuente: si el hash recibido es EXACTAMENTE el de estos mismos campos con la versión anterior, se represa en esta llamada (sin perder la vuelta).
    if(err?.code==='registro_source_changed'&&opts.represar!==false&&raw!==undefined&&this.#hashConVersionAnterior(e,input,principal,raw)===proposalHash){represado='fuenteVersion';registry=await this.registryContext(raw,e,principal,{...opts,rebind:true});}
    else throw err;
   }
   const requestKey=input.requestId?'req_'+hash(principal.id+'\0'+input.negocioId+'\0'+input.requestId).slice(0,40):null;
   if(requestKey){const prior=await this.store.get('amalia_event_requests',requestKey);if(prior){if(prior.data.fingerprint!==fingerprint(input))fail('idempotency_conflict');assertReplayProvenance(prior.data,registry);return {created:false,alreadyCreated:true,...await this.get(prior.data.eventId,input.negocioId,principal)};}}
   const existing=await this.store.get('eventos',eventId);
   if(existing){assertReplayProvenance(existing.data,registry);if(existing.data.retirado===true)fail('event_retired',{eventId});if(existing.data.creationFingerprint===fingerprint(e)){authorize(principal,existing.data.negocioId,'read');return {created:false,alreadyCreated:true,eventId,...existing.data};}fail('duplicate_event_conflict',{eventId,revision:true});}
   if(this.clavesModo==='bloquea'&&!input.requestId)fail('invalid_field',{campo:'requestId',ayuda:'Toda alta lleva una clave de idempotencia: requestId (o idempotencyKey). Repetir la misma llamada devuelve el mismo resultado sin crear nada.'});
   const {guard:gd,scan}=await this.scanAdmisionFicha(e,input,{requireOpen:true});
   if(this.clavesModo==='bloquea'&&scan.claves?.decision==='cola'){const q=await encolarRevision(this.store,{e,eventId,input,principal,scan,procedenciaRegistro:raw||null});fail('requires_review',{colaId:q.id,coincidencias:scan.coincidencias,estado:'review_required',revision:true,ayuda:'Posible duplicado dudoso: queda en la cola revisar_candidatos. Solo Alfred decide (admitir como distinta, fusionar en el existente o descartar). No reintentes.'});}
   if(scan.coincidencias.length)fail('duplicate_event_conflict',{coincidencias:scan.coincidencias,revision:true});
   const hashActual=provenanceProposal(this.proposal(e,input,principal,scan),registry);
   if(hashActual!==proposalHash){
    // Represar en la misma llamada solo si la propuesta es materialmente la misma (mismos campos: título, fecha, municipio, sesión…) y no hay duplicado nuevo (aquí ya no hay coincidencias).
    const mismoContenido=represado==='fuenteVersion'||(huellaCampos&&JSON.stringify(huellaCampos)===JSON.stringify(this.fieldPrints(e,input)));
    if(!(opts.represar!==false&&mismoContenido&&scan.coincidencias.length===0))fail('proposal_changed',{huellaCampos:this.fieldPrints(e,input),ayuda:'Compara huellaCampos con la de preparar_admision: los campos con huella distinta son los que has cambiado. Pasa tal cual el campo evento devuelto y el mismo requestId. Si envías huellaCampos (la de preparar_admision), un cambio del catálogo ajeno a tus campos se represa solo.'});
    represado=represado||'catalogo';
   }
   try{const res0=await this.#createAdmitted(input,principal,{updateTime:gd.updateTime,epoch:gd.data.epoch},null,registry),res=represado&&res0?.created!==false?{...res0,represado:true,motivoRepresado:represado,proposalHashFinal:hashActual}:res0;const avisos=(scan.informativas||[]).filter(i=>i.motivos?.includes('posible_duplicado')).map(i=>({tipo:'posible_duplicado',eventId:i.eventId,mensaje:'Existe un evento con nombre muy parecido, misma fecha, lugar y hora. Se ha admitido; revisa si es el mismo.'}));return avisos.length&&res?.created!==false?{...res,avisos}:res;}
   catch(error){if(error.code!=='version_conflict')throw error;if(attempt===ADMISION_INTENTOS-1)fail('admission_contended');await new Promise(r=>setTimeout(r,20+Math.random()*100));}
  }
  });
 }
 /** Las altas de ESTE servidor no compiten entre sí por la guardia del catálogo: se hacen de una en una (la sección crítica es escaneo + commit, unas décimas de segundo). Solo los escritores externos pueden provocar version_conflict, que se reintenta. AMALIA_ADMISION_SERIE=off lo desactiva. */
 #enSerie(fn){if(process.env.AMALIA_ADMISION_SERIE==='off')return fn();const prev=this.serieAdmision||Promise.resolve();let libera;const mia=new Promise(r=>{libera=r;});this.serieAdmision=prev.then(()=>mia);return prev.then(async()=>{try{return await fn();}finally{libera();}});}
 #hashConVersionAnterior(e,input,principal,raw){const p=normalizeProvenance(raw);return provenanceProposal(this.proposal(e,input,principal,{coincidencias:[]}),{hash:fingerprint(p),input:p});}

 /** Hasta 25 candidatos ya preparados {evento, proposalHash, huellaCampos?}. Cada uno es una admisión normal (escaneo indexado por fecha+municipio+fuente, commit atómico con guardia, represado en la misma llamada). Un fallo no tumba el lote: cada alta sale admitida, omitida, encolada, con error o pendiente (si no llega al presupuesto de tiempo). */
 async admitirLoteCandidatos({items},principal,{presupuestoMs=LOTE_ADMISION_MS}={}){
  if(!Array.isArray(items)||items.length<1||items.length>25)fail('invalid_field',{campo:'items',ayuda:'Entre 1 y 25 candidatos preparados {evento, proposalHash, huellaCampos?}.'});
  const inicio=Date.now(),resultados=[],c={admitidos:0,omitidos:0,encolados:0,errores:0,pendientes:0};
  for(const [i,it] of items.entries()){
   const base={indice:i,titulo:it?.evento?.titulo??null,requestId:it?.evento?.requestId??null};
   const gastado=Date.now()-inicio;
   if(gastado>presupuestoMs){c.pendientes++;resultados.push({...base,estado:'pendiente',motivo:'presupuesto_de_tiempo'});continue;}
   try{
    const r=await this.conCola('admitir',it.evento,principal,()=>this.admitCandidate({accion:'admit',proposalHash:it.proposalHash,evento:it.evento,huellaCampos:it.huellaCampos},principal),{plazoMs:Math.min(this.plazoLlamadaMs,presupuestoMs+5000-gastado)});
    if(r.encolado){c.encolados++;resultados.push({...base,estado:'encolado',motivo:r.motivo,colaId:r.colaId});}
    else if(r.multiple){const ok=(r.creadas||0)+(r.yaExistian||0);c.admitidos+=r.creadas||0;c.omitidos+=(r.omitidas||0)+(r.yaExistian||0);c.errores+=r.errores||0;c.pendientes+=r.pendientes||0;resultados.push({...base,estado:r.completo?'admitido':'parcial',sesiones:r.resultados});void ok;}
    else if(r.created===false){c.omitidos++;resultados.push({...base,estado:'omitido',motivo:'ya_existia',eventId:r.eventId});}
    else{c.admitidos++;resultados.push({...base,estado:'admitido',eventId:r.eventId,...(r.represado?{represado:true,motivoRepresado:r.motivoRepresado,proposalHashFinal:r.proposalHashFinal}:{})});}
   }catch(e){
    if(e instanceof DomainError&&['duplicate_event_conflict','session_key_conflict','requires_review','event_retired'].includes(e.code)){c.omitidos++;resultados.push({...base,estado:'omitido',motivo:e.code,coincidencias:e.details?.coincidencias||null,colaId:e.details?.colaId||null});}
    else{c.errores++;resultados.push({...base,estado:'error',error:e instanceof DomainError?e.code:'operation_failed',...(e instanceof DomainError&&e.details?{detalle:e.details}:{})});}
   }
  }
  return {total:items.length,...c,completo:c.pendientes===0,tiempoMs:Date.now()-inicio,resultados,...(c.pendientes?{aviso:'Se agotó el tiempo de la llamada: repite SOLO los pendientes (mismo evento y hash). Lo ya admitido no se duplica.'}:{})};
 }
 async resolveProgramAncestor(input,principal){
  const {negocioId,eventId,programa,cubiertas,motivo,confirmar=false,proposalHash,expectedVersion}=input;
  authorize(principal,negocioId,'review');const before=await this.locate(eventId,negocioId,principal,'retire');if(before.data.retirado===true)fail('already_retired');
  const business=await this.business(negocioId),bundle=await this.programs.load(programa,business);
  if(!(before.data.fuentes||[]).some(f=>bundle.urls.includes(f.url)))fail('program_ancestor_source_mismatch');
  const units=cubiertas.map(k=>bundle.units.find(u=>u.unidadId===k));if(units.length<2||units.some(u=>!u)||new Set(cubiertas).size!==cubiertas.length)fail('program_ancestor_units_invalid');
  if(units.some(u=>u.facts.fechaLocal!==(before.data.fechaLocal||before.data.fecha_inicio)))fail('program_ancestor_day_mismatch');
  const resolution={kind:'historical_group',programKey:bundle.programKey,eventId,previousUpdateTime:before.updateTime,previousVersion:before.data.version||0,coveredUnits:units.map(u=>({unitKey:u.unidadId,factsHash:u.factsHash,titulo:u.facts.titulo,fechaLocal:u.facts.fechaLocal})),actor:agenteCanonico(principal.id),actorPrincipal:principal.id,reason:motivo};
  const required=fingerprint(resolution);
  if(!confirmar)return {persistido:false,accion:'retirar_y_resolver_agrupador',evento:this.identity(before),cubiertas:resolution.coveredUnits,proposalHash:required,expectedVersion:resolution.previousVersion,efecto:'Solo coincidencias URL/sourceId con unidades disjuntas; las cubiertas permanecen bloqueadas.'};
  if(proposalHash!==required||expectedVersion!==resolution.previousVersion)fail('proposal_changed');
  const universe=await this.catalogUniverse(),evidence=await this.programs.snapshots(bundle);
  return this.retire({eventId,negocioId,expectedVersion,motivo,codigoConfirmacion:this.confirmationCode(before)},principal,{resolution:{...resolution,proposalHash:required,at:new Date().toISOString(),snapshots:evidence.refs},guard:{updateTime:universe.guard.updateTime,epoch:universe.guard.data.epoch},verifies:[{collection:'negocios',key:business.id,updateTime:business.updateTime},...evidence.verifies],extras:evidence.extras});
 }
 async prepareProgram({negocioId,programa},principal) {
  authorize(principal,negocioId,'read');await this.business(negocioId);
  return this.programs.preview({negocioId,programa},principal);
 }
 async programContext(input,principal,requireOpen=false) {
  authorize(principal,input.negocioId,'read');const business=await this.business(input.negocioId);
  const evaluated=await this.programs.evaluate(input,business);
  if(!String(evaluated.event.provincia||'').trim())fail('missing_field',{campo:'provincia',ayuda:'Falta la provincia: indica provincia (o ubicacion.provincia) en el evento del programa.'});
  const universe=await this.catalogUniverse({requireOpen});
  const reconciliation=await this.programs.reconcile(evaluated,universe);
  const eventId=eventIdentity(evaluated.event),existing=universe.docs.find(r=>r.id===eventId);
  const originalFingerprint=fingerprint(input),creationFingerprint=fingerprint({original:input,evidence:evaluated.unit.factsHash});
  let scan=this.programs.filter(this.scanAdmission(evaluated.event,universe),reconciliation);
  const same=existing&&existing.data.creationFingerprint===creationFingerprint&&existing.data.programEvidence?.factsHash===evaluated.unit.factsHash;
  if(same)scan={...scan,coincidencias:scan.coincidencias.filter(c=>c.eventId!==eventId)};
  return {evaluated,universe,reconciliation,eventId,existing,originalFingerprint,creationFingerprint,same,scan};
 }
 async prepareProgramAdmission(original,principal) {
  const {content:input,raw}=splitProvenance(original),c=await this.programContext(input,principal),registry=await this.registryContext(raw,c.evaluated.event,principal);
  return {accionRequerida:'admit',proposalHash:provenanceProposal(this.programs.proposal(c.evaluated,c.scan,principal),registry),eventId:c.eventId,admisible:!c.existing&&c.scan.coincidencias.length===0&&c.universe.guard.data.admissionPaused!==true,alreadyCreated:!!c.same,admissionPaused:c.universe.guard.data.admissionPaused===true,candidato:c.evaluated.event,evento:registry?{...input,procedenciaRegistro:registry.input}:input,...c.scan,persistido:false,acreditacion:{policy:'institutional-program-v1',unidadId:c.evaluated.unit.unidadId,carencias:c.evaluated.unit.carencias}};
 }
 async admitProgramCandidate({proposalHash,evento:original},principal) {
  const {content:input,raw}=splitProvenance(original);
  for(let attempt=0;attempt<3;attempt++) {
   // Evidence and history precede EVERY idempotent return, including source changes on replay.
   const c=await this.programContext(input,principal,true),registry=await this.registryContext(raw,c.evaluated.event,principal);
   if(c.scan.coincidencias.length)fail('duplicate_event_conflict',{coincidencias:c.scan.coincidencias,revision:true});
   if(provenanceProposal(this.programs.proposal(c.evaluated,c.scan,principal),registry)!==proposalHash)fail('proposal_changed',{repreparar:true});
   const requestKey=input.requestId?'req_'+hash(principal.id+'\0'+input.negocioId+'\0'+input.requestId).slice(0,40):null;
   if(requestKey){const prior=await this.store.get('amalia_event_requests',requestKey);if(prior&&(prior.data.fingerprint!==c.originalFingerprint||prior.data.eventId!==c.eventId))fail('idempotency_conflict');if(prior)assertReplayProvenance(prior.data,registry);}
   if(c.existing){assertReplayProvenance(c.existing.data,registry);if(c.existing.data.retirado===true)fail('event_retired',{eventId:c.eventId});if(!c.same)fail('duplicate_event_conflict',{eventId:c.eventId,revision:true});return {created:false,alreadyCreated:true,eventId:c.eventId,...c.existing.data};}
   const evidence=await this.programs.commitEvidence(c.evaluated,c.reconciliation,c.eventId);
   try{return await this.#createAdmitted(input,principal,{updateTime:c.universe.guard.updateTime,epoch:c.universe.guard.data.epoch},{...evidence,event:c.evaluated.event,creationFingerprint:c.creationFingerprint},registry);}
   catch(error){if(error.code!=='version_conflict')throw error;if(attempt===2)fail('admission_contended',{repreparar:true});}
  }
 }
 async get(eventId,businessId,principal) {const r=await this.store.get('eventos',id(eventId));if(!r)fail('event_not_found');if(r.data.negocioId!==businessId)fail('business_forbidden');authorize(principal,r.data.negocioId,'read');return {eventId:r.id,...r.data};}
 // Altas recientes por autor: lee el universo en caché (se revalida con la guardia en cada llamada). Orden: fechaCreacion descendente, luego eventId.
 async listRecentAdmissions({createdBy,agente,desde,hasta,provincia,cursor,limit=50},principal) {
  authorize(principal,null,'read');
  const ms=(v,name)=>{if(v==null)return null;const t=Date.parse(v);if(!Number.isFinite(t))fail('invalid_date',{campo:name,ayuda:'Usa una fecha ISO 8601, p. ej. 2026-11-19T00:00:00+01:00.'});return t;};
  const d0=ms(desde,'desde'),d1=ms(hasta,'hasta'),prov=provincia?normalizeText(provincia):null,n=Math.min(Math.max(Number(limit)||50,1),100);
  let after=null;if(cursor){const i=String(cursor).indexOf('|');if(i<1||!/^[A-Za-z0-9_-]{1,128}$/.test(String(cursor).slice(i+1)))fail('invalid_cursor');const head=String(cursor).slice(0,i),id=String(cursor).slice(i+1),t=/^-?\d+$/.test(head)?Number(head):Date.parse(head);if(!Number.isFinite(t))fail('invalid_cursor');after={t,id,valor:/^-?\d+$/.test(head)?new Date(t).toISOString():head};}
  const pasa=x=>{
   if(x.retirado===true||x.prueba===true)return false;
   if(!principal.actions.includes('*')&&!principal.businesses.includes('*')&&!principal.businesses.includes(x.negocioId))return false;
   if(createdBy&&x.createdBy!==createdBy)return false;
   if(agente&&agenteCanonico(x.agenteCanonico||x.createdBy)!==agenteCanonico(agente))return false;
   if(prov&&normalizeText(x.provincia)!==prov)return false;
   return true;
  };
  const fila=(id,x)=>({eventId:id,negocioId:x.negocioId,titulo:x.titulo||x.nombre||null,city:x.city||null,provincia:x.provincia||null,createdBy:x.createdBy||null,agente:x.createdBy||x.agenteCanonico?agenteCanonico(x.agenteCanonico||x.createdBy):null,fechaCreacion:x.fechaCreacion||null,requestId:x.requestId||null});
  if(typeof this.store.queryPagina==='function'){
   // Consulta indexada por fechaCreacion (descendente) dentro de [desde, hasta]: solo se leen las altas de la ventana, nunca el catálogo. Los eventos antiguos sin fechaCreacion no tienen alta registrada y no se listan.
   const iso=t=>new Date(t).toISOString(),items=[];let total=0,despues=after?{valor:after.valor,id:after.id}:null,leidos=0,siguiente=null,exacto=true;
   for(;;){
    const page=await this.store.queryPagina('eventos','fechaCreacion',{desde:d0!=null?iso(d0):null,hasta:d1!=null?iso(d1):null,despues,desc:true,limit:500});
    leidos+=page.length;
    for(const r of page){if(!pasa(r.data||{}))continue;total++;if(items.length<n)items.push(fila(r.id,r.data));else if(items.length===n&&!siguiente)siguiente=`${items.at(-1).fechaCreacion}|${items.at(-1).eventId}`;}
    if(page.length<500)break;
    const last=page.at(-1);despues={valor:last.data.fechaCreacion,id:last.id};
    if(leidos>=ALTAS_MAX_LECTURAS){exacto=false;if(!siguiente)siguiente=`${despues.valor}|${despues.id}`;break;}
   }
   return {items,total,totalExacto:exacto,cursor:siguiente};
  }
  const universe=await this.catalogUniverse();
  const rows=[];
  for(const r of universe.docs){
   const x=r.data||{};
   if(!pasa(x))continue;
   const t=x.fechaCreacion?Date.parse(x.fechaCreacion):NaN,has=Number.isFinite(t);
   if((d0!=null||d1!=null)&&!has)continue;
   if(d0!=null&&t<d0)continue;if(d1!=null&&t>d1)continue;
   rows.push({id:r.id,t:has?t:-Infinity,x});
  }
  rows.sort((a,b)=>b.t!==a.t?(b.t>a.t?1:-1):(a.id<b.id?1:a.id>b.id?-1:0));
  const key=r=>Number.isFinite(r.t)?r.t:-1e18;
  const start=after?rows.findIndex(r=>key(r)<after.t||(key(r)===after.t&&r.id<after.id)):0;
  const page=start<0?[]:rows.slice(start,start+n);
  const last=page.at(-1),more=start>=0&&start+n<rows.length;
  return {items:page.map(({id,x})=>fila(id,x)),total:rows.length,totalExacto:true,cursor:more&&last?`${key(last)}|${last.id}`:null};
 }
 async list({negocioId,cursor,limit=50,desde,hasta,incluirRetirados=false},principal) {authorize(principal,negocioId,'read');await this.business(negocioId);const rows=await this.store.list('eventos',{business:negocioId,cursor,limit});return {eventos:rows.filter(r=>(incluirRetirados||r.data.retirado!==true)&&(!desde||(r.data.fechaLocal||r.data.dateTime?.slice(0,10))>=desde)&&(!hasta||(r.data.fechaLocal||r.data.dateTime?.slice(0,10))<=hasta)).map(r=>({eventId:r.id,...r.data})),nextCursor:rows.length===limit?rows.at(-1).id:null};}
 async findDuplicates(input,principal) {
  authorize(principal,null,'read');
  const urls=(input.urls||[]).map(u=>String(u)),sourceIds=(input.sourceIds||[]).map(s=>String(s));
  const fMun=input.municipio?normalizeText(input.municipio):null,fDesde=input.desde||null,fHasta=input.hasta||null;
  const title=input.titulo?normalizeText(input.titulo):null,city=input.city?normalizeText(input.city):null,fecha=input.fechaLocal||null,sesion=input.sesionId||(fecha?`${fecha}/${input.horaLocal||'sin-hora'}`:null),sesionExplicita=!!input.sesionId;
  let found=new Map();
  const add=(r,motivo)=>{const cur=found.get(r.id)||{row:r,motivos:[]};if(!cur.motivos.includes(motivo))cur.motivos.push(motivo);found.set(r.id,cur);};
  let huerfana=null;
  if(input.origen){const held=await this.store.get('amalia_event_reservations',originKey(input.origen));if(this.reservaActiva(held)){const ev=await this.store.get('eventos',held.data.eventId);if(ev)add(ev,'reserva_origen_exacta');else huerfana={eventId:held.data.eventId||null,motivos:['reserva_huerfana'],confianza:'exacta'};}}
  if(input.negocioId&&(urls.length||sourceIds.length)&&(sesion||(fecha&&title))){
   const common={negocioId:input.negocioId,fuentes:[{url:urls[0]||'https://invalid.local/',sourceId:sourceIds[0]||null}],fechaLocal:fecha||'',titulo:input.titulo||''};
   const supplied=input.sesionId||null;
   const candidates=[{...common,sesionId:supplied||`${fecha}/`,sesionExplicita:!!supplied,horaLocal:null},{...common,sesionId:sesion||`${fecha}/sin-hora`,sesionExplicita,horaLocal:input.horaLocal||null}];
   for(const guessed of new Set(candidates.map(eventIdentity))){const hit=await this.store.get('eventos',guessed);if(hit)add(hit,'identidad_calculada');}
  }
  const limite=Math.min(Math.max(input.limite||UNIVERSE_MAX_DOCS,100),UNIVERSE_MAX_DOCS);
  const traza=randomUUID(),inicio=new Date().toISOString(),base=[...found].map(([k,v])=>[k,{row:v.row,motivos:[...v.motivos]}]);
  const candRegla={titulo:input.titulo||null,city:input.city||null,lugar:input.lugar||null,fechaLocal:fecha,horaLocal:input.horaLocal||null};
  const guardUpdate=async()=>{try{return (await this.store.get('amalia_catalog_guard','eventos'))?.updateTime||null;}catch{return null;}};
  let escaneados=0,exhaustivo=true,motivoParcial=null,intentos=0,guardAntes=null,guardDespues=null,estado={},omitidasPrueba=0;
  // Barrido paginado por id. Si el catálogo cambia mientras se lee (otra admisión o edición), un documento nuevo podría quedar detrás del cursor: se repite el barrido; si sigue cambiando, el resultado se marca NO exhaustivo.
  for(intentos=1;intentos<=3;intentos++){
   found=new Map(base.map(([k,v])=>[k,{row:v.row,motivos:[...v.motivos]}]));
   let cursor=null;escaneados=0;exhaustivo=true;motivoParcial=null;estado={retirados:0,prueba:0,cancelados:0,vigentes:0};omitidasPrueba=0;
   guardAntes=await guardUpdate();
   while(escaneados<limite){
    const page=Math.min(500,limite-escaneados),rows=await this.store.list('eventos',{cursor,limit:page});
    for(const r of rows){
     escaneados++;const d=r.data;
     if(d.prueba===true)estado.prueba++;else if(d.retirado===true)estado.retirados++;else if(d.verificationStatus==='cancelado'||/cancel/i.test(String(d.estado||'')))estado.cancelados++;else estado.vigentes++;
     if(d.prueba===true&&!String(input.titulo||'').startsWith('[PRUEBA]')){omitidasPrueba++;continue;}
     const dUrls=[...(d.fuentes||[]).map(s=>s.url),d.link,d.enlace_original].filter(Boolean);
     const dSourceIds=(d.fuentes||[]).map(s=>s.sourceId).filter(Boolean);
     const dTitulo=normalizeText(leg(d,'titulo','nombre')),dCity=normalizeText(leg(d,'city','ciudad')||(typeof d.ubicacion==='string'?d.ubicacion:d.ubicacion?.municipio));
     const dFecha=leg(d,'fechaLocal','fecha_inicio')||d.dateTime?.slice(0,10)||null;
     if(fMun&&dCity!==fMun)continue;
     if((fDesde&&(!dFecha||dFecha<fDesde))||(fHasta&&(!dFecha||dFecha>fHasta)))continue;
     const otraSesion=(fecha&&dFecha&&dFecha!==fecha)||(sesionExplicita&&sesion&&d.sesionId&&d.sesionId!==sesion);
     if(urls.length&&dUrls.some(u=>urls.includes(u)))add(r,otraSesion?'url_fuente_otra_sesion':'url_fuente');
     if(sourceIds.length&&dSourceIds.some(s=>sourceIds.includes(s)))add(r,otraSesion?'source_id_otra_sesion':'source_id');
     const cityConflict=city&&dCity&&dCity!==city;
     const sm=motivoSesion({sesionId:sesion,sesionExplicita,titulo:input.titulo,city:input.city,fechaLocal:fecha},r);if(sm)add(r,sm);
     const rg=reglaDuplicado(candRegla,r);if(rg==='duplicado')add(r,'duplicado_sesion');else if(rg==='parecido')add(r,'posible_duplicado');
     if(title&&fecha&&dFecha===fecha){
      if(dTitulo===title)add(r,city&&dCity&&dCity===city?'titulo_fecha_lugar':'titulo_fecha');
      else if(!cityConflict&&Math.min(dTitulo.length,title.length)>=12&&(dTitulo.includes(title)||title.includes(dTitulo)))add(r,'titulo_contenido');
     }
     if(!title&&city&&fecha&&dCity===city&&dFecha===fecha)add(r,'lugar_fecha');
    }
    if(rows.length<page)break;
    cursor=rows.at(-1).id;
    if(escaneados>=limite){exhaustivo=false;motivoParcial='limite_alcanzado';}
   }
   guardDespues=await guardUpdate();
   if(!exhaustivo||!(guardAntes&&guardDespues&&guardAntes!==guardDespues))break;
   if(intentos===3){exhaustivo=false;motivoParcial='catalogo_modificado_durante_lectura';}
  }
  if(intentos>3)intentos=3;
  // Misma clasificación que la admisión: solo bloquean la regla de las cuatro coincidencias, la reserva de origen y la identidad calculada.
  const {coincidencias,informativas}=clasificarCoincidencias(found.values(),row=>this.identity(row));
  // Igual que la admisión: una reserva de origen cuyo evento ya no existe sigue bloqueando.
  if(huerfana)coincidencias.push(huerfana);
  const fin=new Date().toISOString(),alcance={coleccion:'eventos',filtros:{negocio:null,estado:null,zona:null,municipio:input.municipio||null,fechas:fDesde||fHasta?{desde:fDesde,hasta:fHasta}:null},incluye:['capturados','retirados','cancelados','pasados','legacy'],excluidoDeLaComparacion:omitidasPrueba?{prueba:omitidasPrueba}:{},limite,documentosEnColeccion:escaneados,composicion:estado,reservasOrigen:input.origen?'consultada':'no_aplica'};
  return {coincidencias,informativas,escaneados,exhaustivo,...(motivoParcial?{motivoParcial}:{}),traza,alcance,barrido:{inicio,fin,intentos,catalogoEstable:!!(guardAntes&&guardAntes===guardDespues)},nota:'REGLA 2.18.0: solo es duplicado (bloquea) lo que coincide en nombre normalizado (minusculas, sin tildes ni signos), fecha, lugar (recinto y municipio) y hora (o falta en uno de los dos); ademas bloquean la reserva de origen y la identidad calculada. confianza=posible_duplicado (en informativas): nombre muy parecido con misma fecha, lugar y hora; no bloquea, revisalo. Cualquier otra señal (URL, sourceId, sesion, titulo contenido) es informativa y no bloquea. alcance describe el barrido: sin filtros, todos los documentos de eventos; el tamaño varia porque otros procesos (p. ej. la sincronizacion de Fever) añaden y borran documentos sin pasar por el MCP; traza localiza el barrido en los logs. Si exhaustivo=false (motivoParcial indica por que) hay registros sin revisar: detén la creación e informa.'};
 }
 async update({eventId,negocioId,expectedVersion,changes,reason,evidenciaUrl=null,simular=false},principal) {
  authorize(principal,negocioId,'edit');
  return this.#applyEdit({eventId,negocioId,expectedVersion,changes,reason,evidenciaUrl,mode:'edit',simular:simular===true},principal);
 }
 async #applyEdit({eventId,negocioId,expectedVersion,changes,reason,evidenciaUrl,mode,simular=false},principal) {
  const ALLOWED=new Set(['sesiones','titulo','descripcion','city','fechaLocal','horaLocal','timeZone','dateTime','dateTimeEnd','fechaFinLocal','sesionId','origen','fuentes','lugar','categoria','categorias','tipo','precio','precioInfo','geoUbicacion','provincia','pais','aforo','assetId','image','imageRights','sustainableTip','publicTransport','etiquetas','direccion','fuente_nombre','fuente_tipo','verificationStatus','conflictos','cta','prueba','fuenteId','link']);
  const IDENTITY=new Set(['titulo','city','fechaLocal','horaLocal','timeZone','dateTime','dateTimeEnd','fechaFinLocal','sesionId','origen','fuentes','lugar','link','sesiones']);
  const SCAN=['titulo','city','fechaLocal','horaLocal','dateTime','sesionId','origen','fuentes','sesiones'];
  if(Object.keys(changes).some(k=>!ALLOWED.has(k)))fail(['link','ubicacion','temporalidad'].some(k=>k in changes)?'immutable_event_identity':'immutable_or_unknown_field');
  // En completar, añadir fuentes solo suma procedencia (la propia URL nueva es la evidencia).
  const identityTouched=Object.keys(changes).filter(k=>IDENTITY.has(k)&&!(mode==='complete'&&k==='fuentes'));
  if(identityTouched.length){
   let ev;try{ev=new URL(evidenciaUrl);}catch{fail('evidence_required',{campos:identityTouched,ayuda:'Cambiar fecha, hora, título, lugar o fuentes exige evidenciaUrl: la página HTTPS donde la fuente anuncia el cambio.'});}
   if(ev.protocol!=='https:'||ev.username||ev.password)fail('evidence_required',{campos:identityTouched});
  }
  for(let attempt=0;attempt<3;attempt++){
   const before=await this.store.get('eventos',id(eventId));if(!before)fail('event_not_found');if(before.data.negocioId!==negocioId)fail('business_forbidden',{ayuda:'El negocioId indicado no es el del evento; usa el negocioId real.',negocioIdDelEvento:before.data.negocioId});
   if(before.data.retirado===true)fail('event_retired',{eventId,retiradoEn:before.data.retiradoEn});
   if((before.data.version || 0)!==expectedVersion)fail('version_conflict',{currentVersion:before.data.version||0});
   const old=before.data,ch={...changes};
   if('titulo' in ch&&!tituloSoloForma(old.titulo??old.nombre,ch.titulo,[old.city,ch.city]))fail('title_meaning_changed',{ayuda:'Solo se corrigen mayúsculas, signos, fechas o ciudad incrustados. Un título con otro significado es otro evento: retira y da de alta.'});
   if('fuentes' in ch){ch.fuentes=mergeSources(old.fuentes,ch.fuentes);assertFuentePrimaria(ch.fuentes);}
   if('fuenteId' in ch){
    if(ch.fuenteId===null)fail('invalid_source_id',{ayuda:'fuenteId no se puede quitar desde editar_evento; indica el id de la fuente correcta.'});
    const f=typeof ch.fuenteId==='string'?ch.fuenteId.trim():'';
    if(!/^(fte_[a-z]+_[0-9a-f]{24}|F-[A-Z0-9]{2,6}-\d{3,5})$/.test(f))fail('invalid_source_id',{ayuda:'fuenteId: el id de la fuente en el registro de fuentes (fte_… o F-XXX-0000), el que devuelve buscar_fuente/registrar_fuente.'});
    if(f.startsWith('fte_')&&!(await this.store.get('registro_fuentes',f)))fail('source_not_found',{fuenteId:f,ayuda:'Esa fuente no existe en registro_fuentes: búscala con buscar_fuente.'});
    ch.fuenteId=f;
   }
   if('sesiones' in ch){
    // Solo se AÑADEN sesiones: la lista nueva debe contener las que ya tiene la ficha y ninguna anterior a su fecha principal.
    const nuevas=normSesiones(ch.sesiones),clave=x=>x.fechaLocal+'|'+(x.horaLocal||'');
    const previas=(Array.isArray(old.sesiones)&&old.sesiones.length?old.sesiones:[{fechaLocal:old.fechaLocal??old.fecha_inicio,horaLocal:old.horaLocal??old.hora??null}]).filter(x=>x.fechaLocal);
    const faltan=previas.filter(x=>!nuevas.some(y=>clave(y)===clave(x)));
    if(faltan.length)fail('sessions_cannot_be_removed',{faltan:faltan.map(x=>({fechaLocal:x.fechaLocal,horaLocal:x.horaLocal||null})),ayuda:'editar_evento solo añade sesiones: incluye también las que ya tiene la ficha.'});
    if(old.fechaLocal&&nuevas[0].fechaLocal<old.fechaLocal)fail('session_before_primary',{fechaLocal:old.fechaLocal,ayuda:'Una sesión anterior a la fecha principal cambia la identidad de la ficha: edita fechaLocal con evidenciaUrl.'});
    ch.sesiones=nuevas;
    const ultima=nuevas.at(-1).fechaLocal;if(!('fechaFinLocal' in ch)&&ultima>(old.fechaLocal||'')&&(old.fechaFinLocal==null||old.fechaFinLocal<ultima))ch.fechaFinLocal=ultima;
   }
   let reserveMove=null;
   if('origen' in ch){
    const o0=old.origen;if(!o0)fail('origin_cannot_be_added');
    const o1={...o0,...ch.origen};
    if(o1.proveedor!==o0.proveedor||o1.id_externo!==o0.id_externo)fail('origin_identity_immutable',{ayuda:'Solo puede cambiar origen.id_sesion.'});
    if('sesionId' in ch&&ch.sesionId!==o1.id_sesion)fail('session_id_follows_origin');
    if(o1.id_sesion===o0.id_sesion)delete ch.origen;
    else{ch.origen=o1;ch.sesionId=o1.id_sesion;const k=originKey(o1),destRow=await this.store.get('amalia_event_reservations',k);if(this.reservaActiva(destRow))fail('duplicate_event_conflict',{reservaOrigen:k,revision:true});const fromRow=await this.store.get('amalia_event_reservations',originKey(o0));reserveMove={from:originKey(o0),fromRow,...(fromRow?{}:{sinOrigenPrevio:true}),to:{id:k,...(destRow?{updateTime:destRow.updateTime}:{}),data:{eventId,negocioId,origen:o1,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,at:new Date().toISOString()}}};}
   }else if('sesionId' in ch&&old.origen)fail('session_id_follows_origin');
   // Quitar la imagen: assetId:null o image:null (ambos o uno solo); no se mezcla con una imagen nueva.
   const quitarImagen=('assetId' in ch&&ch.assetId===null)||('image' in ch&&ch.image===null);
   if(quitarImagen){
    if((ch.assetId!=null)||(ch.image!=null))fail('invalid_changes',{ayuda:'Para quitar la imagen usa assetId:null o image:null sin pasar una imagen nueva.'});
    ch.assetId=null;ch.image=null;
   }
   let input={...old,...ch,negocioId};
   // `ubicacion` y `town` son alias persistidos de la ciudad y `canonicalInput` da prioridad a `ubicacion`: sin esto, cambiar `city` se ignoraba en silencio.
   if('city' in ch){const u=old.ubicacion;input.ubicacion=u&&typeof u==='object'?{...u,municipio:ch.city}:ch.city;input.town=ch.city;}
   if(quitarImagen)input.sourceImageUrl=null;
   const horario=['fechaLocal','horaLocal','timeZone'].some(k=>k in ch);
   if(horario&&!('dateTime' in ch))input.dateTime=null;
   if(horario&&!('dateTimeEnd' in ch))input.dateTimeEnd=null;
   // Una sesión sin ID explícito deriva de fecha/hora: se recalcula; la explícita (o la del origen) se conserva.
   if(horario&&!('sesionId' in ch)&&old.sesionExplicita!==true&&!old.origen)input.sesionId=undefined;
   if(input.assetId && !ch.image){const asset=this.media.get(input.assetId,negocioId,principal);input={...input,image:asset.url,sourceImageUrl:asset.sourceUrl};}
   if(ch.image && !ch.assetId){const asset=await this.media.persist({url:ch.image,sourceUrl:input.link,negocioId,rights:ch.imageRights || {status:'unknown'}},principal);input={...input,assetId:asset.id,image:asset.url,sourceImageUrl:ch.image};}
   const e=canonicalInput(input,{preservarCategorias:!('categoria' in ch||'categorias' in ch)}),now=new Date().toISOString(),rec=record(e,principal,now);
   const after={...old,...rec,metrics:old.metrics || {views:0,clicks:0,interactions:0},version:expectedVersion+1,fechaCreacion:old.fechaCreacion,createdBy:old.createdBy || null,updatedBy:agenteCanonico(principal.id),updatedByPrincipal:principal.id,fechaActualizacion:now};
   if(old.ubicacion&&typeof old.ubicacion==='object')after.ubicacion='city' in ch?input.ubicacion:old.ubicacion;
   const precioTocado='precio' in ch || 'precioInfo' in ch;
   if(!precioTocado)for(const k of ['precio','precioEstado','precioDetalle']){if(k in old)after[k]=old[k];else delete after[k];}
   const GEO=['geo','geo_precision','geo_fuente','lat','lng'];
   // geo*, geo_precision y geo_fuente los escribe también el geocodificador: solo se tocan si se cambia geoUbicacion.
   if(!('geoUbicacion' in ch))for(const k of GEO){if(k in old)after[k]=old[k];else delete after[k];}
   let updateFields=Object.keys(rec).filter(k=>!['fechaCreacion','createdBy','metrics'].includes(k)&&!(k==='ubicacion'&&typeof old.ubicacion==='object'&&old.ubicacion&&!('city' in ch))&&(precioTocado||!['precio','precioEstado','precioDetalle'].includes(k))&&('geoUbicacion' in ch||!GEO.includes(k)));
   // El mapa oculta por `estado`, no por verificationStatus.
   if(e.verificationStatus==='cancelado'){after.estado='cancelado';updateFields.push('estado');}
   else if(old.verificationStatus==='cancelado'&&old.estado==='cancelado'){delete after.estado;updateFields.push('estado');}
   if(['lugar','direccion','city'].some(k=>k in ch&&normalizeText(ch[k])!==normalizeText(old[k]))){after.geo_revision_pendiente=true;updateFields.push('geo_revision_pendiente');}
   if(identityTouched.length){after.evidenciaUrl=evidenciaUrl;updateFields.push('evidenciaUrl');}
   updateFields=[...new Set(updateFields)];
   let guard;
   if(SCAN.some(k=>k in ch)){
    // Mismo protocolo que la admisión: escaneo exhaustivo contra los demás eventos y commit atómico con la guardia.
    if(this.clavesModo==='bloquea'){
     const scan=await this.scanPorClaves(e,{eventId});
     if(scan.coincidencias.length)fail('duplicate_event_conflict',{coincidencias:scan.coincidencias,revision:true});
     guard={updateTime:(await this.catalogGuard()).updateTime};
    }else{
     const universe=await this.candidateUniverse(e),scan=this.scanAdmission(e,{...universe,docs:universe.docs.filter(r=>r.id!==eventId),reservas:universe.reservas.filter(r=>r.eventId!==eventId)});
     if(scan.coincidencias.length)fail('duplicate_event_conflict',{coincidencias:scan.coincidencias,revision:true});
     guard={updateTime:universe.guard.updateTime};
    }
   }
   if(simular){
    const diff=Object.fromEntries(updateFields.filter(k=>JSON.stringify(old[k]??null)!==JSON.stringify(after[k]??null)).map(k=>[k,{antes:old[k]??null,despues:after[k]??null}]));
    return {simulado:true,escrito:false,eventId,versionActual:old.version||0,versionResultante:after.version,camposQueCambian:Object.keys(diff),cambios:diff,duplicadosComprobados:SCAN.some(k=>k in ch),siguientePaso:`Repite sin simular (o con simular=false), con expectedVersion=${old.version||0} y los mismos changesJson/reason. Nada se ha escrito.`};
   }
   let clavesEdicion=null;
   try{
    clavesEdicion=this.clavesModo==='off'?null:await this.planClaves(eventId,old,after);
    await this.store.write('eventos',eventId,after,{updateTime:before.updateTime,updateFields,guard,claves:clavesEdicion,moveReserve:reserveMove,audit:{version:after.version,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,action:mode==='complete'?'completed':'updated',reason,evidenciaUrl:evidenciaUrl||null,at:now,before:old,after}});
   }catch(error){if(error.code==='version_conflict'&&this.clavesModo==='bloquea'&&clavesEdicion)await this.conflictoClave([...clavesEdicion.crear,...clavesEdicion.actualizar],eventId);if(error.code==='version_conflict'&&attempt<2){const cur=await this.store.get('eventos',eventId);if(cur&&(cur.data.version||0)===expectedVersion)continue;}throw error;}
   return {eventId,...after};
  }
 }
 /** Rellena SOLO huecos: nunca sobrescribe ni borra un valor existente. Acción `complete`. */
 async complete({eventId,negocioId,expectedVersion,campos,motivo,evidenciaUrl=null,simular=false},principal) {
  authorize(principal,negocioId,'complete');
  const row=await this.store.get('eventos',id(eventId));if(!row)fail('event_not_found');if(row.data.negocioId!==negocioId)fail('business_forbidden');
  const d=row.data,apply={},omitidos=[];
  const vacio=v=>v==null||v===''||(Array.isArray(v)&&!v.length);
  const skip=(k,motivo)=>omitidos.push({campo:k,motivo});
  const rango={municipio:1,direccion_aproximada:2,recinto:3};
  const rangoActual=d.geoUbicacion?.tipo?rango[d.geoUbicacion.tipo]:d.geo_precision==='lugar'?3:d.geo&&d.geo_precision==='ciudad'?1:(d.lat!=null&&d.lng!=null)?2:0;
  for(const [k,v] of Object.entries(campos)){
   if(v==null)continue;
   switch(k){
    case 'horaLocal':if(vacio(d.horaLocal??d.hora))apply.horaLocal=v;else skip(k,d.horaLocal===v?'sin_cambios':'ya_tiene_valor');break;
    case 'direccion':case 'fuente_nombre':case 'fuente_tipo':case 'sustainableTip':case 'publicTransport':{const cur=k==='sustainableTip'?d['local-sustainable-tip']??d.sustainableTip:k==='publicTransport'?d['public-transport']??d.publicTransport:d[k];if(vacio(cur))apply[k]=v;else skip(k,cur===v?'sin_cambios':'ya_tiene_valor');break;}
    case 'etiquetas':{const cur=d.etiquetas||[],union=[...new Set([...cur,...v])];if(union.length===cur.length)skip(k,'sin_cambios');else apply.etiquetas=union;break;}
    case 'fuentes':{const merged=mergeSources(d.fuentes,v);if(fingerprint(merged)===fingerprint(d.fuentes||[]))skip(k,'sin_cambios');else apply.fuentes=v;break;}
    case 'precioInfo':if((d.precioEstado??'desconocido')==='desconocido'&&v.estado!=='desconocido')apply.precioInfo=v;else skip(k,v.estado==='desconocido'?'sin_cambios':'ya_tiene_valor');break;
    case 'geoUbicacion':if(rango[v.tipo]>rangoActual)apply.geoUbicacion=v;else skip(k,'no_mejora_la_precision_actual');break;
    case 'categorias':case 'categoria':if(vacio(d.categorias)&&vacio(d.categoria??d.category))apply[k]=v;else skip(k,'ya_tiene_valor');break;
    case 'lugar':{const city=normalizeText(d.city??d.ubicacion);if(vacio(d.lugar)||normalizeText(d.lugar)===city){if(normalizeText(v)!==city)apply.lugar=v;else skip(k,'igual_que_el_municipio');}else skip(k,'ya_tiene_valor');break;}
    case 'assetId':if(vacio(d.image??d.imagen)&&vacio(d.assetId))apply.assetId=v;else skip(k,'ya_tiene_valor');break;
    default:fail('complete_field_not_allowed',{campo:k});
   }
  }
  if(!Object.keys(apply).length)return {completado:false,eventId,version:d.version||0,aplicados:[],omitidos,nota:'No había huecos que rellenar: no se ha escrito nada.'};
  const out=await this.#applyEdit({eventId,negocioId,expectedVersion,changes:apply,reason:motivo,evidenciaUrl,mode:'complete',simular},principal);
  if(out.simulado)return {...out,completado:false,aplicarian:Object.keys(apply),omitidos};
  return {completado:true,eventId,version:out.version,aplicados:Object.keys(apply),omitidos};
 }
 identity(r){const d=r.data;return {eventId:r.id,negocioId:d.negocioId,titulo:d.titulo||d.nombre||null,fechaLocal:d.fechaLocal||d.fecha_inicio||null,horarioTexto:d.horarioTexto||d.hora||null,ciudad:d.city||d.ciudad||null,lugar:d.lugar||null,sesionId:d.sesionId||null,verificationStatus:d.verificationStatus||null,prueba:d.prueba===true,version:d.version||0,fuentes:(d.fuentes||[]).map(s=>s.url).slice(0,3),creadoPor:d.createdBy||null,creadoEn:d.fechaCreacion||null,retirado:d.retirado===true};}
 async locate(eventId,negocioId,principal,action) {authorize(principal,negocioId,action);const before=await this.store.get('eventos',id(eventId));if(!before)fail('event_not_found');if(before.data.negocioId!==negocioId)fail('business_forbidden',{ayuda:'El negocioId indicado no es el del evento; usa el negocioId real.',negocioIdDelEvento:before.data.negocioId});return before;}
 confirmationCode(before) {return fingerprint({e:before.id,n:before.data.negocioId,v:before.data.version||0,t:before.updateTime}).slice(0,12);}
 async retirePreview({eventId,negocioId},principal) {
  const before=await this.locate(eventId,negocioId,principal,'retire');
  if(before.data.retirado===true)fail('already_retired',{eventId,retiradoEn:before.data.retiradoEn,retiradoPor:before.data.retiradoPor});
  return {evento:this.identity(before),versionActual:before.data.version||0,codigoConfirmacion:this.confirmationCode(before)};
 }
 async retire({eventId,negocioId,expectedVersion,motivo,codigoConfirmacion},principal,programResolution=null) {
  const before=await this.locate(eventId,negocioId,principal,'retire');
  if(before.data.retirado===true)fail('already_retired',{eventId,retiradoEn:before.data.retiradoEn,retiradoPor:before.data.retiradoPor});
  if(typeof motivo!=='string'||motivo.trim().length<3||motivo.length>500)fail('reason_required');
  if((before.data.version || 0)!==expectedVersion)fail('version_conflict',{currentVersion:before.data.version || 0});
  if(codigoConfirmacion!==this.confirmationCode(before))fail('confirmation_mismatch');
  const now=new Date().toISOString(),version=expectedVersion+1,old=before.data;
  const patch={retirado:true,retiradoPor:agenteCanonico(principal.id),retiradoPorPrincipal:principal.id,retiradoEn:now,retiradoMotivo:motivo.trim(),retiradoVersion:expectedVersion,estadoAnterior:old.estado ?? null,activaAnterior:old.activa ?? null,estado:'retirado',activa:false,version,updatedBy:agenteCanonico(principal.id),updatedByPrincipal:principal.id,fechaActualizacion:now};
  if(programResolution)patch.programAncestorResolution=programResolution.resolution;
  const clavesRetiro=this.clavesModo==='off'?null:await this.planClaves(eventId,old,null);
  await this.store.write('eventos',eventId,patch,{updateTime:before.updateTime,claves:clavesRetiro,guard:programResolution?.guard,verifies:programResolution?.verifies,extras:programResolution?.extras,updateFields:Object.keys(patch),audit:{version,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,action:'retired',reason:patch.retiradoMotivo,at:now,before:{retirado:false,estado:old.estado ?? null,activa:old.activa ?? null,version:expectedVersion},after:patch}});
  return {eventId,...old,...patch};
 }
 async restorePreview({eventId,negocioId},principal) {
  const before=await this.locate(eventId,negocioId,principal,'restore'),old=before.data;
  if(old.retirado!==true)fail('not_retired',{eventId});
  return {evento:this.identity(before),versionActual:old.version||0,retiradoPor:old.retiradoPor??null,retiradoEn:old.retiradoEn??null,retiradoMotivo:old.retiradoMotivo??null,efectos:['El evento vuelve a ser visible (retirado=false).',`Se restaura estado=${old.estadoAnterior??'(sin cambio)'} y activa=${old.activaAnterior??'(sin cambio)'}.`,'Las piezas detenidas en Kalma no se reanudan solas.']};
 }
 async restore({eventId,negocioId,expectedVersion,motivo},principal) {
  const before=await this.locate(eventId,negocioId,principal,'restore'),old=before.data;
  if(old.retirado!==true)fail('not_retired',{eventId});
  if(typeof motivo!=='string'||motivo.trim().length<3||motivo.length>500)fail('reason_required');
  if((old.version || 0)!==expectedVersion)fail('version_conflict',{currentVersion:old.version || 0});
  const now=new Date().toISOString(),version=expectedVersion+1;
  const patch={retirado:false,retiradoPor:null,retiradoPorPrincipal:null,retiradoEn:null,retiradoMotivo:null,retiradoVersion:null,estadoAnterior:null,activaAnterior:null,recuperadoPor:agenteCanonico(principal.id),recuperadoPorPrincipal:principal.id,recuperadoEn:now,recuperadoMotivo:motivo.trim(),version,updatedBy:agenteCanonico(principal.id),updatedByPrincipal:principal.id,fechaActualizacion:now};
  const fields=Object.keys(patch);
  if(old.estadoAnterior!=null)patch.estado=old.estadoAnterior;
  if(old.activaAnterior!=null)patch.activa=old.activaAnterior;
  const mask=[...fields,'estado','activa'];
  const clavesRestauro=this.clavesModo==='off'?null:await this.planClaves(eventId,null,{...old,...patch});
  try{await this.store.write('eventos',eventId,patch,{updateTime:before.updateTime,updateFields:mask,claves:clavesRestauro,audit:{version,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,action:'restored',reason:patch.recuperadoMotivo,at:now,before:{retirado:true,retiradoPor:old.retiradoPor ?? null,retiradoEn:old.retiradoEn ?? null,version:expectedVersion},after:patch}});}catch(error){if(error.code==='version_conflict'&&this.clavesModo==='bloquea'&&clavesRestauro)await this.conflictoClave([...clavesRestauro.crear,...clavesRestauro.actualizar],eventId);throw error;}
  const after={eventId,...old,...patch};if(!('estado' in patch))delete after.estado;if(!('activa' in patch))delete after.activa;return after;
 }
 async history(eventId,businessId,principal){await this.get(eventId,businessId,principal);return {eventId,revisiones:await this.store.revisions(eventId)};}
 async saveCandidate(input,principal) {
  authorizeCapture(principal,null);
  const titulo=input.titulo?.trim()||null,descripcion=input.descripcion?.trim()||null;
  if(!titulo&&!descripcion)fail('invalid_candidate');
  const carencias=(input.carencias||[]).map(c=>String(c).trim()).filter(Boolean);
  if(!carencias.length||carencias.length>20)fail('carencias_required');
  const fuentes=(input.fuentes||[]).map(s=>{const url=typeof s==='string'?s:s?.url;let u;try{u=new URL(url);}catch{fail('invalid_url');}if(u.protocol!=='https:')fail('https_required');return {url:u.href,checkedAt:typeof s==='object'?s.checkedAt||null:null,sourceId:typeof s==='object'?s.sourceId||null:null};});
  if(!fuentes.length)fail('source_required');
  const tipo=['evento','experiencia','establecimiento','desconocido'].includes(input.tipo)?input.tipo:'desconocido';
  const origen=input.origen?{proveedor:String(input.origen.proveedor||''),id_externo:String(input.origen.id_externo||''),id_sesion:String(input.origen.id_sesion||'')}:null;
  if(origen&&(!origen.proveedor||origen.proveedor.length>300||origen.id_externo.length>300||origen.id_sesion.length>300))fail('invalid_origin');
  const now=new Date().toISOString();
  const data={titulo,descripcion,tipo,city:input.city||null,lugar:input.lugar||null,provincia:input.provincia||null,pais:input.pais||null,fechaLocal:input.fechaLocal||null,horaLocal:input.horaLocal||null,...extrasCandidato(input),carencias,fuentes,origen,datos:typeof input.datos==='string'?input.datos.slice(0,8000):null,notas:input.notas||null,estado:'pendiente',fechaCreacion:now,fechaActualizacion:now,createdBy:principal.id,version:1,managedBy:'amalia-events-v2'};
  const candId=input.requestId?'cand_'+hash(principal.id+'\0'+input.requestId).slice(0,40):'cand_'+fingerprint({t:titulo,d:descripcion,c:data.city,f:fuentes.map(f=>f.url),o:origen,ce:carencias}).slice(0,40);
  const contentKeys=['titulo','descripcion','tipo','city','lugar','provincia','pais','fechaLocal','horaLocal','carencias','fuentes','origen','datos','notas','createdBy'];
  const contentFingerprint=value=>fingerprint(Object.fromEntries([...contentKeys.map(k=>[k,value[k]??null]),...['etiquetas','direccion','fuente_nombre','fuente_tipo','fuenteId'].filter(k=>value[k]!=null).map(k=>[k,value[k]])]));
  const fp=contentFingerprint(data),prior=await this.store.get('candidatos_eventos',candId);
  if(prior){if(contentFingerprint(prior.data)!==fp)fail('idempotency_conflict');return {created:false,alreadyCreated:true,candidatoId:candId,...prior.data};}
  await this.store.write('candidatos_eventos',candId,{...data,huella:fp},{create:true,audit:{version:1,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,action:'candidate_stored',at:now,after:{...data,huella:fp}}});
  return {created:true,candidatoId:candId,...data,coleccion:'candidatos_eventos',aviso:'Candidato privado fuera del catálogo público: no aparece en búsquedas ni en eventos.'};
 }
 async listCandidates({estado,cursor,limit=50},principal) {
  authorize(principal,null,'read');
  const rows=await this.store.list('candidatos_eventos',{cursor,limit});
  const items=rows.filter(r=>!estado||r.data.estado===estado).map(r=>({candidatoId:r.id,...r.data}));
  return {candidatos:items,nextCursor:rows.length===limit?rows.at(-1).id:null};
 }
 async discardCandidate({candidatoId,motivo},principal) {
  authorize(principal,null,'edit');
  if(typeof motivo!=='string'||motivo.trim().length<3||motivo.length>500)fail('reason_required');
  const before=await this.store.get('candidatos_eventos',id(candidatoId));if(!before)fail('candidate_not_found');
  if(before.data.estado==='descartado')fail('already_discarded',{candidatoId});
  const now=new Date().toISOString(),patch={estado:'descartado',descartadoMotivo:motivo.trim(),descartadoEn:now,updatedBy:agenteCanonico(principal.id),updatedByPrincipal:principal.id,fechaActualizacion:now,version:(before.data.version||1)+1};
  await this.store.write('candidatos_eventos',before.id,{...before.data,...patch},{updateTime:before.updateTime,audit:{version:patch.version,actor:agenteCanonico(principal.id),actorPrincipal:principal.id,action:'candidate_discarded',reason:patch.descartadoMotivo,at:now,before:{estado:before.data.estado},after:patch}});
  return {candidatoId:before.id,...before.data,...patch};
 }
}
