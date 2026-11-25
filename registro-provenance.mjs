import {hash,fingerprint,fail,authorize,id,httpsUrl,DomainError} from './event-domain.mjs';
import {queryIdentity} from './registro-fuentes.mjs';
const keys=(o,allowed)=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!allowed.includes(k)))fail('registro_provenance_invalid');};
const text=(s,max=500)=>{if(typeof s!=='string'||!s.trim()||s.length>max||/[\u0000-\u001f\u007f]/.test(s))fail('registro_provenance_invalid');return s.trim();};
const instant=s=>{if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))fail('registro_provenance_invalid_date');return new Date(s).toISOString();};
const url=s=>{const u=new URL(httpsUrl(s));if(u.hash||!u.hostname.includes('.')||/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(u.hostname)||/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname))fail('registro_provenance_invalid_url');return u.href;};
export function splitProvenance(input){const {procedenciaRegistro,...content}=input;return {content,raw:procedenciaRegistro};}
export function normalizeProvenance(raw){
 keys(raw,['version','fuenteId','fuenteVersion','canalFuente','identificadorCanonico','urlPrimaria','evidenciaEditorial','canalEntrada']);
 if(raw.version!==1||!['web','instagram','tiktok','correo'].includes(raw.canalFuente))fail('registro_provenance_invalid');
 keys(raw.evidenciaEditorial,['responsable','verificadoEn','relacion','urls','observacion']);const e=raw.evidenciaEditorial;
 if(!Array.isArray(e.urls)||e.urls.length<1||e.urls.length>5)fail('registro_provenance_evidence_required');
 keys(raw.canalEntrada,['canal','referencia']);const entrada={canal:text(raw.canalEntrada.canal,40)};if(raw.canalEntrada.referencia!=null)entrada.referencia=text(raw.canalEntrada.referencia,500);
 return {version:1,fuenteId:id(raw.fuenteId),fuenteVersion:(()=>{instant(raw.fuenteVersion);return raw.fuenteVersion;})(),canalFuente:raw.canalFuente,identificadorCanonico:text(raw.identificadorCanonico,300),urlPrimaria:url(raw.urlPrimaria),evidenciaEditorial:{responsable:text(e.responsable,160),verificadoEn:instant(e.verificadoEn),relacion:text(e.relacion,2000),urls:[...new Set(e.urls.map(url))],observacion:text(e.observacion,2000)},canalEntrada:entrada};
}
function canonicalRegistry(f){
 if(f.canal==='web'){let u;try{u=new URL(f.url);}catch{fail('registro_source_identity_invalid');}const host=u.hostname.toLowerCase().replace(/^www\./,''),path=u.pathname.replace(/\/+$/,'')+queryIdentity(host,u);if(!/^https?:$/.test(u.protocol)||u.username||u.password||!host.includes('.')||/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(host)||/^\d+\.\d+\.\d+\.\d+$/.test(host)||f.identificador!==`${host}${path}`.toLowerCase()||f.url!==`https://${host}${path}`)fail('registro_source_identity_invalid');}
 else if(f.canal==='instagram'){if(!/^[a-z0-9._]{1,30}$/.test(f.identificador)||f.url!==`https://www.instagram.com/${f.identificador}/`)fail('registro_source_identity_invalid');}
 else if(f.canal==='tiktok'){if(!/^[a-z0-9._]{1,30}$/.test(f.identificador)||f.url!==`https://www.tiktok.com/@${f.identificador}`)fail('registro_source_identity_invalid');}
 else if(f.canal==='correo'){if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.identificador)||f.identificador!==f.identificador.toLowerCase()||f.url!=='')fail('registro_source_identity_invalid');}
}
export function registrySnapshot(row){
 const f=row?.data;if(!f||!row.updateTime)fail('registro_source_not_found');
 if(f.id!==row.id||f.origen!=='asistente'||f.negocio_id!==null||!['activa','en_comprobacion','descubierta'].includes(f.estado))fail('registro_source_ineligible');
 if(!['web','instagram','tiktok','correo'].includes(f.canal)||typeof f.identificador!=='string'||f.id!==`fte_${f.canal}_${hash(f.identificador).slice(0,24)}`)fail('registro_source_identity_invalid');
 canonicalRegistry(f);
 if(typeof f.municipio!=='string'||!f.municipio.trim())fail('registro_source_identity_invalid');
 return {id:row.id,version:row.updateTime,canal:f.canal,identificador:f.identificador,url:f.url??null,nombreEntidad:f.nombre_entidad??null,municipio:f.municipio,estado:f.estado,origen:f.origen,negocioId:f.negocio_id};
}
/** Corte por defecto si AMALIA_FUENTES_V2_DESDE_ISO no está definida: día en que se habilitó `review` (AMALia) para la procedencia de registro. Cualquier fecha pasada vale; el corte queda en cada registro de procedencia. */
export const REGISTRY_CUTOFF_DEFAULT='2026-11-22T00:00:00.000Z';
let cutoffAvisado=false;
/** Opción explícita > variable de entorno > valor por defecto con aviso en el log (una vez por proceso). Un valor presente pero mal formado sigue fallando cerrado al usarse. */
export function registryCutoffConfig(option,env=process.env.AMALIA_FUENTES_V2_DESDE_ISO,log=m=>console.error(m)){
 if(option!==undefined&&option!==null)return {cutoff:option,porDefecto:false};
 const e=typeof env==='string'?env.trim():'';
 if(e)return {cutoff:e,porDefecto:false};
 if(!cutoffAvisado){cutoffAvisado=true;log(JSON.stringify({level:'warn',msg:'AMALIA_FUENTES_V2_DESDE_ISO no está definida: se usa el corte por defecto',cutoff:REGISTRY_CUTOFF_DEFAULT}));}
 return {cutoff:REGISTRY_CUTOFF_DEFAULT,porDefecto:true};
}
export function cutoffValue(value){try{return instant(value);}catch{fail('registro_cutoff_unconfigured');}}
/** Códigos de CONFIGURACIÓN que, con degradar:true, no bloquean el alta: se admite sin procedencia y se marca procedenciaPendiente (reconciliar_procedencias la adjunta cuando la config vuelva). Los errores de DATOS siguen bloqueando. */
export const PROCEDENCIA_DEGRADABLE=['registro_cutoff_unconfigured','registro_cutoff_not_reached'];
export async function prepareProvenance(store,raw,event,principal,{cutoff,now=new Date().toISOString(),degradar=false,rebind=false}={}){
 if(raw===undefined)return null;
 authorize(principal,event.negocioId,'review');let p=normalizeProvenance(raw);const at=instant(now);
 let since=null,pendiente=null;
 try{since=cutoffValue(cutoff);if(Date.parse(at)<Date.parse(since))fail('registro_cutoff_not_reached');}
 catch(e){if(!degradar||!(e instanceof DomainError)||!PROCEDENCIA_DEGRADABLE.includes(e.code))throw e;pendiente=e.code;}
 if(Date.parse(p.evidenciaEditorial.verificadoEn)>Date.parse(at))fail('registro_provenance_future_verification');
 if(p.urlPrimaria!==event.fuentes?.[0]?.url)fail('registro_primary_mismatch');
 const row=await store.get('registro_fuentes',p.fuenteId),snapshot=registrySnapshot(row);
 let reenlazada=null;if(snapshot.version!==p.fuenteVersion){if(!rebind)fail('registro_source_changed',{repreparar:true});reenlazada=p.fuenteVersion;p={...p,fuenteVersion:snapshot.version};}
 if(snapshot.canal!==p.canalFuente||snapshot.identificador!==p.identificadorCanonico)fail('registro_source_identity_mismatch');
 const provenanceHash=fingerprint(p);
 if(pendiente){console.error(JSON.stringify({level:'warn',event:'procedencia_degradada',motivo:pendiente,fuenteId:p.fuenteId,aviso:'El alta entra sin procedencia (procedenciaPendiente=true): arregla AMALIA_FUENTES_V2_DESDE_ISO o espera; reconciliar_procedencias la adjuntará.'}));return {degradada:true,motivo:pendiente,input:p,datos:p,hash:provenanceHash};}
 return {input:p,hash:provenanceHash,verify:{collection:'registro_fuentes',key:row.id,updateTime:row.updateTime},record:{policy:'authorized-editorial-registry-v1',procedencia:p,fuente:snapshot,actorServidor:principal.id,registradaEn:at,corte:since,provenanceHash}};
}
export function provenanceProposal(base,ctx){return ctx?fingerprint({proposal:base,provenanceHash:ctx.hash,fuenteVersion:ctx.input.fuenteVersion}):base;}
export function assertReplayProvenance(record,ctx){if((record?.provenanceHash??null)!==(ctx?.hash??null))fail('registro_provenance_conflict');}
export async function registryCapabilities(store,principal,fuenteId,cutoff){
 authorize(principal,null,'read');const mayReview=principal.actions.includes('*')||principal.actions.includes('review');
 let configured=false;try{cutoffValue(cutoff);configured=true;}catch{}
 const out={principalId:principal.id,canReview:mayReview,canAdmit:principal.actions.includes('*')||principal.actions.includes('admit'),cutoffConfigured:configured,policy:'authorized-editorial-registry-v1'};
 if(fuenteId){authorize(principal,null,'review');out.fuente=registrySnapshot(await store.get('registro_fuentes',id(fuenteId)));}
 return out;
}
