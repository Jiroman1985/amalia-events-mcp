import https from 'node:https';
import {lookup} from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import {hash,fail,httpsUrl} from './event-domain.mjs';
// Only routable global unicast. Reject transition mechanisms, mapped addresses and reserved blocks.
const denied4=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.88.99.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3'].map(ipaddr.parseCIDR);
const denied6=['2001::/23','2001:db8::/32','2002::/16','3fff::/20'].map(ipaddr.parseCIDR);
export function publicIP(value){try{const a=ipaddr.parse(value);if(a.kind()==='ipv4')return a.range()==='unicast'&&!denied4.some(c=>a.match(c));return !a.isIPv4MappedAddress()&&a.match(ipaddr.parseCIDR('2000::/3'))&&a.range()==='unicast'&&!denied6.some(c=>a.match(c));}catch{return false;}}
const timeoutError=()=>Object.assign(new Error('source_timeout'),{code:'source_timeout'});
export class ProgramCapture {
 constructor({resolve=lookup,request=https.request,timeoutMs=12000,maxBytes=262144,maxRedirects=3}={}){Object.assign(this,{resolve,request,timeoutMs,maxBytes,maxRedirects});}
 async capture(url){
  let current=new URL(httpsUrl(url));current.hash='';if(current.search)fail('program_query_unsupported');
  const original=current.href,host=current.hostname,started=Date.now(),hops=[];
  for(let redirect=0;;redirect++){
   if(redirect>this.maxRedirects)fail('source_redirect_limit');
   const remain=this.timeoutMs-(Date.now()-started);if(remain<=0)throw timeoutError();
   let timer;const addresses=await Promise.race([this.resolve(current.hostname,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeoutError()),remain);})]).finally(()=>clearTimeout(timer));
   if(!Array.isArray(addresses)||!addresses.length||addresses.some(a=>!publicIP(a.address)))fail('source_private_address');
   const address=addresses[0],budget=this.timeoutMs-(Date.now()-started);if(budget<=0)throw timeoutError();
   const result=await new Promise((resolve,reject)=>{
    let req,done=false,bytes=0;const chunks=[];
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(total);error?reject(error):resolve(value);};
    const total=setTimeout(()=>{finish(timeoutError());req?.destroy();},budget);
    try{req=this.request(current,{method:'GET',agent:false,servername:current.hostname,headers:{host:current.host,'user-agent':'AMALIA-ProgramEvidence/1.0','accept':'text/html','accept-encoding':'identity'},lookup:(_hostname,options,cb)=>options?.all?cb(null,[address]):cb(null,address.address,address.family)},res=>{
     const actual=res.socket?.remoteAddress;const normalized=ip=>{try{const a=ipaddr.parse(ip);return a.kind()==='ipv6'&&a.isIPv4MappedAddress()?a.toIPv4Address().toString():a.toString();}catch{return null;}};
     if(normalized(actual)!==normalized(address.address)){finish(new Error('source_peer_mismatch'));res.destroy();return;}
     const status=res.statusCode,encoding=String(res.headers['content-encoding']||'identity');
     if(encoding!=='identity'){finish(new Error('source_encoding_unsupported'));res.destroy();return;}
     if(Number(res.headers['content-length'])>this.maxBytes){finish(new Error('source_too_large'));res.destroy();return;}
     res.on('data',chunk=>{bytes+=chunk.length;if(bytes>this.maxBytes){finish(new Error('source_too_large'));res.destroy();req.destroy();return;}chunks.push(chunk);});
     res.on('end',()=>finish(null,{status,headers:{location:res.headers.location||null,contentType:res.headers['content-type']||'',etag:res.headers.etag||null,lastModified:res.headers['last-modified']||null},rawBase64:Buffer.concat(chunks).toString('base64'),connectedIP:actual,body:Buffer.concat(chunks).toString('utf8'),bytes}));
     res.on('error',e=>finish(e));res.on('aborted',()=>finish(new Error('source_aborted')));
    });req.on('error',e=>finish(e));req.end();}catch(e){finish(e);}
   });
   const hop={url:current.href,resolved:addresses.map(a=>a.address),selectedIP:address.address,connectedIP:result.connectedIP,status:result.status,headers:result.headers,bytes:result.bytes,body:result.body,rawBase64:result.rawBase64,sha256:hash(Buffer.from(result.rawBase64,'base64')),capturedAt:new Date().toISOString()};hops.push(hop);
   if([301,302,303,307,308].includes(result.status)){
    if(!result.headers.location)fail('source_redirect_missing');const next=new URL(httpsUrl(new URL(result.headers.location,current).href));next.hash='';
    // Another public host is NOT proof of the original institution's authority.
    if(next.hostname!==host||next.search)fail('source_cross_host_redirect');current=next;continue;
   }
   if(result.status!==200)fail('source_http_error',{status:result.status});
   if(!/^text\/html(?:;|$)/i.test(result.headers.contentType)||(/charset=/i.test(result.headers.contentType)&&!/charset=["']?utf-8/i.test(result.headers.contentType))||result.body.includes('\uFFFD'))fail('source_content_type');
   return {originalUrl:original,finalUrl:current.href,hops,body:result.body,digest:hash(hops.map(h=>({url:h.url,status:h.status,sha256:h.sha256,location:h.headers.location}))),capturedAt:hop.capturedAt};
  }
 }
}
