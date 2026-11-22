import { randomUUID } from 'node:crypto';
import { fail } from './event-domain.mjs';
export class CloudMedia {
 constructor({bucket,auth,fetchImpl=fetch}){this.bucket=bucket;this.auth=auth;this.fetch=fetchImpl;}
 async put({filename,bytes,mime,sourceUrl}){
  const name='amalia_events/'+filename,token=randomUUID(),boundary='amalia_'+randomUUID();
  const metadata={name,contentType:mime,metadata:{firebaseStorageDownloadTokens:token,sourceUrl,managedBy:'amalia-events-v2'}};
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const url=new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);url.searchParams.set('uploadType','multipart');url.searchParams.set('ifGenerationMatch','0');
  const r=await this.fetch(url,{method:'POST',headers:{...await this.auth(),'content-type':`multipart/related; boundary=${boundary}`},body,signal:AbortSignal.timeout(20000)});
  let document;
  if([409,412].includes(r.status)){const existing=await this.fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}`,{headers:await this.auth(),signal:AbortSignal.timeout(12000)});if(!existing.ok)fail('cloud_media_lookup_failed');document=await existing.json();}
  else {if(!r.ok)fail('cloud_media_upload_failed',{status:r.status});document=await r.json();}
  const downloadToken=document.metadata?.firebaseStorageDownloadTokens?.split(',')[0];if(!downloadToken)fail('cloud_media_token_missing');
  return {url:`https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}?alt=media&token=${encodeURIComponent(downloadToken)}`,bucket:this.bucket,object:name,generation:document.generation};
 }
}
