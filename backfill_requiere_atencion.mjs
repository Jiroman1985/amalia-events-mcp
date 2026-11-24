// backfill_requiere_atencion.mjs — rellena el campo booleano `requiere_atencion` en el documento raíz de cada hilo de `tablon_agentes`. DRY-RUN por defecto.
//   node backfill_requiere_atencion.mjs                              (ensayo: cuántas raíces cambian y cuántas quedan en true)
//   node backfill_requiere_atencion.mjs --aplicar --confirmo <huella>
// Solo escribe en las raíces cuyo valor guardado falta o difiere (versión de escritura con updateTime); los mensajes de respuesta no se tocan.
import { createHash } from 'node:crypto';
import { FirestoreStore } from './firestore-store.mjs';
import { COL, CAMPO_ATENCION, planAtencion, recalcularAtencion } from './tablon.mjs';

const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const plan = planAtencion(await store.listAll(COL, { max: 100000 }));
const huella = createHash('sha256').update(JSON.stringify(plan.cambios.map(c => [c.id, c.despues]))).digest('hex').slice(0, 16);
const informe = { generado: new Date().toISOString(), coleccion: COL, campo: CAMPO_ATENCION, modo: process.argv.includes('--aplicar') ? 'APLICAR' : 'ENSAYO (no se ha escrito nada)', huella, raices: plan.raices, requierenAtencion: plan.aTrue, aCambiar: plan.cambios.length, sinValorGuardado: plan.cambios.filter(c => c.antes === null).length, muestra: plan.cambios.slice(0, 5) };
if (!process.argv.includes('--aplicar')) { console.log(JSON.stringify(informe, null, 1)); process.exit(0); }
if (arg('confirmo') !== huella) { console.error('La huella no coincide: repite el ensayo. Actual: ' + huella); process.exit(2); }
const corregidos = await recalcularAtencion(store);
console.log(JSON.stringify({ ...informe, corregidos: corregidos.length, pendientes: planAtencion(await store.listAll(COL, { max: 100000 })).cambios.length }, null, 1));
