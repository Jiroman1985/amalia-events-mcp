// reparar_url_normalizada.mjs — corrige url_normalizada incoherente. ENSAYO por defecto (no escribe).
//   node reparar_url_normalizada.mjs [--solo <fuenteId>] [--salida informe.json]
//   node reparar_url_normalizada.mjs --aplicar --solo <fuenteId>        (una fuente)
//   node reparar_url_normalizada.mjs --aplicar --confirmo <total>      (todas las del ensayo; total = nº de fuentes del ensayo)
import { writeFileSync } from 'node:fs';
import { FirestoreStore } from './firestore-store.mjs';
import { readRegistry } from './registro-fuentes.mjs';
import { planReparacionUrl } from './reparacion-url.mjs';
const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const plan = planReparacionUrl(await readRegistry(store), arg('solo'));
if (arg('salida')) writeFileSync(arg('salida'), JSON.stringify(plan, null, 2));
if (!process.argv.includes('--aplicar')) { console.log(JSON.stringify({ modo: 'ENSAYO (no se ha escrito nada)', total: plan.total, porCanal: plan.porCanal, muestra: plan.items.slice(0, 5) }, null, 2)); process.exit(0); }
if (!arg('solo') && Number(arg('confirmo')) !== plan.total) { console.error(`Confirmación distinta: el ensayo da ${plan.total} fuentes (--confirmo ${plan.total}).`); process.exit(2); }
const ahora = new Date().toISOString(), log = { corregidas: 0, errores: [] };
for (const i of plan.items) {
  try {
    const row = await store.get('registro_fuentes', i.fuenteId), d = { ...row.data, url_normalizada: i.despues, modificada_por: 'mantenimiento', modificada_en: ahora, historial: [...(row.data.historial || []), { en: ahora, por: 'mantenimiento', motivo: 'Corrección de url_normalizada (la migración de la hoja la copió de la columna URL)', cambios: [{ campo: 'url_normalizada', antes: row.data.url_normalizada ?? null, despues: i.despues }] }].slice(-25) };
    await store.write('registro_fuentes', i.fuenteId, d, { updateTime: row.updateTime }); log.corregidas++;
  } catch (e) { log.errores.push({ fuenteId: i.fuenteId, error: e.code || e.message }); }
}
console.log(JSON.stringify(log, null, 2));
