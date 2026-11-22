// rellenar_url_normalizada.mjs — rellena url_normalizada AUSENTE en fuentes de Instagram (instagram.com/<usuario>). ENSAYO por defecto.
//   node rellenar_url_normalizada.mjs                         (ensayo)
//   node rellenar_url_normalizada.mjs --aplicar --confirmo N  (N = nº de fuentes del ensayo)
import { FirestoreStore } from './firestore-store.mjs';
import { readRegistry } from './registro-fuentes.mjs';
import { planRelleno } from './reparacion-url.mjs';
const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const plan = planRelleno(await readRegistry(store));
if (!process.argv.includes('--aplicar')) { console.log(JSON.stringify({ modo: 'ENSAYO (no se ha escrito nada)', total: plan.total, omitidas: plan.omitidas, items: plan.items }, null, 2)); process.exit(0); }
if (Number(arg('confirmo')) !== plan.total) { console.error(`Confirmación distinta: el ensayo da ${plan.total} (--confirmo ${plan.total}).`); process.exit(2); }
const ahora = new Date().toISOString(), log = { rellenadas: 0, errores: [] };
for (const i of plan.items) {
  try {
    const row = await store.get('registro_fuentes', i.fuenteId);
    if (row.data.url_normalizada != null) continue;
    const d = { ...row.data, url_normalizada: i.valor, modificada_por: 'mantenimiento', modificada_en: ahora, historial: [...(row.data.historial || []), { en: ahora, por: 'mantenimiento', motivo: 'Relleno de url_normalizada ausente (aprobado)', cambios: [{ campo: 'url_normalizada', antes: null, despues: i.valor }] }].slice(-25) };
    await store.write('registro_fuentes', i.fuenteId, d, { updateTime: row.updateTime }); log.rellenadas++;
  } catch (e) { log.errores.push({ fuenteId: i.fuenteId, error: e.code || e.message }); }
}
console.log(JSON.stringify(log, null, 2));
