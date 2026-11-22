import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { businessReferenceUrl,httpsUrl,diagnosticStage,DomainError } from '../event-domain.mjs';
import { MediaStore } from '../media-store.mjs';
const actor={id:'test',actions:['*'],businesses:['*']};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mNQAAAAASUVORK5CYII=','base64');
const input={url:'https://example.org/a.png',sourceUrl:'https://example.org/e',negocioId:'b',rights:{status:'unknown'}};
test('business references allow HTTP but automated downloads still require HTTPS',()=>{
 assert.equal(businessReferenceUrl('http://example.org/'),'http://example.org/');
 for(const u of ['file:///etc/passwd','http://user:password@example.org']) assert.throws(()=>businessReferenceUrl(u));
 assert.throws(()=>httpsUrl('http://example.org/a.png'),/https_required/);
});
test('stage diagnostics preserve domain error code and never expose arbitrary exception',async()=>{
 await assert.rejects(diagnosticStage('negocio_guardado',()=>{throw Error('secret-example')},{possiblePartial:true}),e=>e.code==='operation_failed'&&e.details.etapa==='negocio_guardado'&&e.details.resultado==='incierto'&&!JSON.stringify(e.details).includes('secret-example'));
 await assert.rejects(diagnosticStage('negocio_consulta',()=>{throw new DomainError('backend_auth_failed')}),e=>e.code==='backend_auth_failed'&&e.details.etapa==='negocio_consulta');
});
test('media download and cloud failures are distinguished and mark possible partial effects',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'diag-')),db=new DatabaseSync(':memory:');
 try {
  const badDownload=new MediaStore({directory,db,downloader:async()=>{throw Error('private-url')}});
  await assert.rejects(badDownload.persist(input,actor),e=>e.code==='operation_failed'&&e.details.etapa==='imagen_descarga'&&e.details.resultado==='sin_escritura_en_esta_etapa');
  const badCloud=new MediaStore({directory,db,downloader:async()=>png,cloud:{put:async()=>{throw Error('credentials')}}});
  await assert.rejects(badCloud.persist(input,actor),e=>e.code==='operation_failed'&&e.details.etapa==='imagen_nube'&&e.details.resultado==='incierto'&&!JSON.stringify(e.details).includes('credentials'));
 } finally {db.close();rmSync(directory,{recursive:true,force:true});}
});
