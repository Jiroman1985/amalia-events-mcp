// backfill_normalizar.mjs — normaliza fechaLocal, city y provincia en eventos antiguos. DRY-RUN por defecto: no escribe nada.
//   node backfill_normalizar.mjs [--salida plan.json]                          (ensayo: resumen, omitidos y muestra)
//   node backfill_normalizar.mjs --aplicar --confirmo <huella> [--lote 100]    (escribe en lotes atómicos con versión, auditoría y guardia)
// Solo rellena huecos (nunca pisa valores) y marca cada documento con `normalizacion_backfill_v1`. Antes de aplicar, repite el ensayo: la huella debe coincidir.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FirestoreStore } from './firestore-store.mjs';
import { planNormalizacion, aplicarPlan } from './normalizacion-antiguos.mjs';

const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const aplicar = process.argv.includes('--aplicar'), lote = Math.min(Math.max(Number(arg('lote')) || 100, 1), 200);
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const rows = await store.listAll('eventos', { max: 100000 });
const plan = planNormalizacion(rows);
const huella = createHash('sha256').update(JSON.stringify(plan.cambios.map(c => [c.id, c.version, c.despues]))).digest('hex').slice(0, 16);
const informe = { generado: new Date().toISOString(), modo: aplicar ? 'APLICAR' : 'ENSAYO (no se ha escrito nada)', huella, resumen: plan.resumen, omitidos: plan.omitidos, muestra: plan.cambios.slice(0, 8) };
if (!aplicar) { const out = arg('salida'); if (out) writeFileSync(out, JSON.stringify({ ...informe, cambios: plan.cambios }, null, 1)); console.log(JSON.stringify(informe, null, 1)); process.exit(0); }
if (arg('confirmo') !== huella) { console.error('La huella no coincide: repite el ensayo. Actual: ' + huella); process.exit(2); }
const resultado = await aplicarPlan(store, plan, { lote });
console.log(JSON.stringify({ modo: 'APLICADO', ...resultado }, null, 1));
