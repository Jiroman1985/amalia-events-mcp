// exportar_fuentes_sheet.mjs — regenera la hoja «Fuentes actuales amalia» (solo lectura) desde Firestore. Pensado para cron diario.
//   node exportar_fuentes_sheet.mjs --salida fuentes.csv                       (solo CSV, no toca la hoja)
//   node exportar_fuentes_sheet.mjs --hoja-id <id> --pestana Fuentes --escribir (sustituye la pestaña; la cuenta de servicio necesita ser editora)
import { writeFileSync } from 'node:fs';
import { FirestoreStore } from './firestore-store.mjs';
import { readRegistry } from './registro-fuentes.mjs';
import { filasExportacion, aCsv } from './fuentes-export.mjs';
import { escribirPestana } from './google-sheets.mjs';
const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const filas = filasExportacion(await readRegistry(store));
if (arg('salida')) writeFileSync(arg('salida'), aCsv(filas));
if (process.argv.includes('--escribir')) {
  if (!arg('hoja-id')) { console.error('--escribir necesita --hoja-id'); process.exit(2); }
  await escribirPestana({ hojaId: arg('hoja-id'), pestana: arg('pestana') || 'Fuentes', filas, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
}
console.log(JSON.stringify({ fuentes: filas.length - 1, csv: arg('salida') || null, hojaActualizada: process.argv.includes('--escribir') }));
