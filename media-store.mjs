import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,statSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DomainError,authorize,authorizeCapture,fail,hash,fingerprint,httpsUrl,diagnosticStage } from './event-domain.mjs';

export function publicAddress(ip) {
 if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||(b===0&&(c===0||c===2))))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));}
 if(isIP(ip)===6){const s=ip.toLowerCase();return !s.startsWith('::')&&!s.startsWith('fc')&&!s.startsWith('fd')&&!s.startsWith('fe8')&&!s.startsWith('fe9')&&!s.startsWith('fea')&&!s.startsWith('feb')&&!s.startsWith('ff')&&s!=='::1';}
 return false;
}
// Clasificación segura (sin URL ni mensajes del servidor remoto) del motivo por el que falla una descarga de imagen.
export function causaDescarga(err){
 const c=String(err?.code||'');
 if(/^(ENOTFOUND|EAI_AGAIN|EAI_NODATA|ENODATA)$/.test(c))return 'dns';
 if(/^(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|ETIMEDOUT|EADDRNOTAVAIL)$/.test(c))return 'conexion';
 if(/CERT|SSL|TLS|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(c))return 'certificado';
 return 'red';
}
const descargaFallida=(causa,extra={})=>new DomainError('imagen_descarga_fallida',{causa,...extra});
export async function downloadImage(url,redirects=0) {
 const u=new URL(httpsUrl(url));if(redirects>3)fail('too_many_redirects');
 let addresses;try{addresses=await lookup(u.hostname,{all:true});}catch(e){throw descargaFallida(causaDescarga(e));}
 if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))fail('private_image_host');
 const address=addresses.find(x=>x.family===4)||addresses[0]; // este servidor no tiene ruta IPv6: preferir IPv4
 return new Promise((resolve,reject)=>{
  const req=https.get(u,{family:address.family,autoSelectFamily:false,lookup:(_host,options,cb)=>process.nextTick(()=>options?.all?cb(null,[address]):cb(null,address.address,address.family)),headers:{'user-agent':'AMALIA-event-assets/2.0'},timeout:12000},res=>{
   if([301,302,303,307,308].includes(res.statusCode)){res.resume();downloadImage(new URL(res.headers.location,u).href,redirects+1).then(resolve,reject);return;}
   if(res.statusCode!==200){res.resume();reject(descargaFallida('http_'+res.statusCode,{estadoHttp:res.statusCode}));return;}
   const chunks=[];let size=0;res.on('data',c=>{size+=c.length;if(size>8_000_000){req.destroy();reject(descargaFallida('demasiado_grande',{maxBytes:8000000}));}else chunks.push(c);});res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);
  });let agotado=false;req.on('error',err=>reject(descargaFallida(agotado?'timeout':causaDescarga(err))));req.on('timeout',()=>{agotado=true;req.destroy();});
 });
}
export function imageType(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',ext:'png'};
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {mime:'image/jpeg',ext:'jpg'};
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return {mime:'image/webp',ext:'webp'};
 fail('unsupported_image_type');
}
export class MediaStore {
 constructor({directory,db,publicBase,downloader=downloadImage,cloud=null,store=null}){this.dir=directory;this.db=db;this.publicBase=publicBase;this.downloader=downloader;this.cloud=cloud;this.store=store;mkdirSync(directory,{recursive:true});db.exec('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY,business TEXT NOT NULL,data TEXT NOT NULL)');}
 async persist({url,sourceUrl,negocioId,rights={status:'unknown'}},principal){
  authorizeCapture(principal,negocioId);httpsUrl(sourceUrl);httpsUrl(url);
  if(!['unknown','owned','licensed','permission','public_domain'].includes(rights.status))fail('invalid_rights_status');
  if(rights.status!=='unknown' && (!rights.evidence || !rights.credit))fail('rights_evidence_and_credit_required');
  return this.persistBytes({bytes:await diagnosticStage('imagen_descarga',()=>this.downloader(url)),originalUrl:url,sourceUrl,negocioId,rights},principal);
  }
  async uploadChunk(input,principal){
   const {negocioId,sha256,sourceUrl,rights,bytes,index,total,base64}=input;
   authorizeCapture(principal,negocioId);httpsUrl(sourceUrl);
   if(!this.cloud)fail('private_cloud_storage_required');
   if(!Number.isInteger(bytes)||bytes<1||bytes>8_000_000||!Number.isInteger(index)||!Number.isInteger(total)||total!==Math.ceil(4*Math.ceil(bytes/3)/12000)||index<0||index>=total)fail('invalid_image_chunk');
   const expected=index===total-1?4*Math.ceil(bytes/3)-index*12000:12000;
   if(typeof base64!=='string'||base64.length!==expected||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)||Buffer.from(base64,'base64').toString('base64')!==base64)fail('invalid_image_base64');
   if(!/^[a-f0-9]{64}$/.test(sha256||''))fail('image_hash_mismatch');
   if(!['unknown','owned','licensed','permission','public_domain'].includes(rights?.status))fail('invalid_rights_status');
   if(rights.status!=='unknown'&&(!rights.evidence||!rights.credit))fail('rights_evidence_and_credit_required');
   this.db.exec('CREATE TABLE IF NOT EXISTS image_uploads (id TEXT PRIMARY KEY, actor TEXT NOT NULL, expires INTEGER NOT NULL, asset TEXT); CREATE TABLE IF NOT EXISTS image_chunks (upload TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(upload,idx))');
   const now=Date.now();this.db.prepare('DELETE FROM image_chunks WHERE upload IN (SELECT id FROM image_uploads WHERE expires<?)').run(now);this.db.prepare('DELETE FROM image_uploads WHERE expires<?').run(now);
   const key=hash(fingerprint({actor:principal.id,negocioId,sha256,sourceUrl,rights,bytes,total}));
   let row=this.db.prepare('SELECT * FROM image_uploads WHERE id=?').get(key);
   if(row?.asset)return {complete:true,asset:this.get(row.asset,negocioId,principal)};
   if(!row){if(this.db.prepare('SELECT COUNT(*) n FROM image_uploads WHERE actor=? AND asset IS NULL').get(principal.id).n>=5)fail('too_many_image_uploads');this.db.prepare('INSERT INTO image_uploads(id,actor,expires) VALUES(?,?,?)').run(key,principal.id,now+15*60000);row={expires:now+15*60000};}
   const old=this.db.prepare('SELECT data FROM image_chunks WHERE upload=? AND idx=?').get(key,index);if(old&&old.data!==base64)fail('image_chunk_conflict');
   this.db.prepare('INSERT OR IGNORE INTO image_chunks(upload,idx,data) VALUES(?,?,?)').run(key,index,base64);
   const chunks=this.db.prepare('SELECT idx,data FROM image_chunks WHERE upload=? ORDER BY idx').all(key);
   if(chunks.length<total)return {complete:false,received:chunks.length,total,expiresAt:new Date(row.expires).toISOString()};
   const assembled=chunks.map(c=>c.data).join('');if(Buffer.from(assembled,'base64').length!==bytes)fail('image_size_mismatch');
   const asset=await this.upload({negocioId,sha256,sourceUrl,rights,base64:assembled},principal);
   this.db.prepare('UPDATE image_uploads SET asset=? WHERE id=?').run(asset.id,key);this.db.prepare('DELETE FROM image_chunks WHERE upload=?').run(key);
   return {complete:true,asset};
  }
  async upload({base64,sha256,sourceUrl,negocioId,rights={status:'unknown'}},principal){
   authorizeCapture(principal,negocioId);
   if(typeof base64!=='string'||!base64.length||base64.length>10666668||base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))fail('invalid_image_base64');
   if(!this.cloud)fail('private_cloud_storage_required');
   const bytes=Buffer.from(base64,'base64');if(bytes.toString('base64')!==base64)fail('invalid_image_base64');
   if(!/^[a-f0-9]{64}$/.test(sha256||'')||hash(bytes)!==sha256)fail('image_hash_mismatch');
  return this.persistBytes({bytes,originalUrl:null,sourceUrl,negocioId,rights},principal);
  }
  async persistBytes({bytes,originalUrl,sourceUrl,negocioId,rights},principal){
   authorizeCapture(principal,negocioId);httpsUrl(sourceUrl);
   if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>8_000_000)fail('image_too_large');
   if(!['unknown','owned','licensed','permission','public_domain'].includes(rights.status))fail('invalid_rights_status');
   if(rights.status!=='unknown'&&(!rights.evidence||!rights.credit))fail('rights_evidence_and_credit_required');
   const type=imageType(bytes),digest=hash(bytes),assetId='asset_'+hash(negocioId+'\0'+digest+'\0'+fingerprint(rights)).slice(0,32),filename=digest+'.'+type.ext;
  const path=join(this.dir,filename);await diagnosticStage('imagen_local',()=>{if(!existsSync(path)){const tmp=path+'.'+process.pid+'.tmp';writeFileSync(tmp,bytes,{mode:0o644});renameSync(tmp,path);}},{possiblePartial:true});
  const remote=this.cloud?await diagnosticStage('imagen_nube',()=>this.cloud.put({filename,bytes,mime:type.mime,sourceUrl}),{possiblePartial:true}):null;
  const data={id:assetId,negocioId,url:remote?.url||`${this.publicBase}/media/${filename}`,cloud:remote,sourceUrl,originalUrl,sha256:digest,bytes:bytes.length,mime:type.mime,filename,rights,capturedAt:new Date().toISOString(),createdBy:principal.id};
  if(this.store){try{await diagnosticStage('imagen_registro',()=>this.store.write('amalia_assets',assetId,data,{create:true}),{possiblePartial:true});}catch(e){if(e.code!=='version_conflict')throw e;}}
  await diagnosticStage('imagen_indice',()=>this.db.prepare('INSERT OR IGNORE INTO assets(id,business,data) VALUES (?,?,?)').run(assetId,negocioId,JSON.stringify(data)),{possiblePartial:true});return this.get(assetId,negocioId,principal);
 }
 get(assetId,business,principal){authorize(principal,business,'read');const row=this.db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);if(!row||row.business!==business)fail('asset_not_found');const data=JSON.parse(row.data),present=existsSync(join(this.dir,data.filename));if((!present&&!data.cloud)||(present&&hash(readFileSync(join(this.dir,data.filename)))!==data.sha256))fail('asset_missing_or_changed');return data;}
 async restore(){if(!this.store)return;let cursor;do{const rows=await this.store.list('amalia_assets',{cursor,limit:100});for(const row of rows)this.db.prepare('INSERT OR IGNORE INTO assets(id,business,data) VALUES(?,?,?)').run(row.id,row.data.negocioId,JSON.stringify(row.data));cursor=rows.length===100?rows.at(-1).id:null;}while(cursor);}
 serve(filename){if(!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(filename))return null;const rows=this.db.prepare('SELECT data FROM assets').all();if(rows.some(r=>{const a=JSON.parse(r.data);return a.filename===filename&&a.originalUrl===null;}))return null;const p=join(this.dir,filename);if(!existsSync(p))return null;const bytes=readFileSync(p),mime=imageType(bytes).mime;return {bytes,mime};}
}
