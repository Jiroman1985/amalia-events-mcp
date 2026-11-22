// guardia_commit.mjs — Constructor de referencia del write de guardia para el commit Firestore REST,
// EXTRAÍDO del MCP amalia-events (firestore-store.mjs). Los writers externos lo usan para que su
// escritura a `eventos` y el bump de la guardia vayan EN EL MISMO commit (POST .../documents:commit).
//
// Reglas (ver contrato_guardia_v2.md):
//  - Escritura ORDINARIA externa: buildGuardWrite(prefix)           -> currentDocument {exists:true}
//  - Admisión plena (protocolo A): buildGuardWrite(prefix, {updateTime: leido, epoch: leidoEpoch})
//  - JAMÁS crear la guardia: si exists:true falla (404/precondition), abortar y avisar (fail-closed).
//  - bumpAt: el MCP usa ISO de cliente (new Date().toISOString()); serverTimestamp también vale, lo
//    importante es que cambie en CADA commit. epoch SOLO lo incrementan admisiones confirmadas.
//
// Flujo bidireccional obligatorio para writers que CREAN o tocan campos del escaneo (casos A/B):
//   1. GET amalia_catalog_guard/eventos -> {updateTime, epoch}
//   2. Escaneo exhaustivo con dedup_amalia.mjs (tope 5000; exhaustivo=false => abortar e informar)
//   3. Sin conflictos -> UN commit: writes = [...tusWrites, buildGuardWrite(prefix,{updateTime,epoch})]
//   4. commit FAILED_PRECONDITION/404/ABORTED -> reintentar desde el paso 1, máx. 3 intentos;
//      agotados -> abortar ruidosamente (fail-closed), nunca escribir a ciegas.

export function buildGuardWrite(prefix, {updateTime=null, epoch=null}={}) {
 const fields={bumpAt:{stringValue:new Date().toISOString()}};
 const mask=['bumpAt'];
 if(epoch!=null){fields.epoch={integerValue:String(epoch+1)};mask.push('epoch');}
 const w={update:{name:`${prefix}/amalia_catalog_guard/eventos`,fields},updateMask:{fieldPaths:mask}};
 w.currentDocument=updateTime?{updateTime}:{exists:true};
 return w;
}
// prefix = `projects/${project}/databases/(default)/documents`
// Valores Firestore REST: string -> {stringValue}, entero -> {integerValue:String(n)}, timestamp ISO ok como stringValue (así lo hace el MCP).
