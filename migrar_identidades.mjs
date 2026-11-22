// migrar_identidades.mjs — unifica alias de agente (alfred-altas → alfred, amalia-asistente → amalia…) en tablón, tareas, fuentes, zonas y eventos.
//   ENSAYO (por defecto, NO escribe):  node migrar_identidades.mjs --salida informe.json
//   APLICAR (solo con aprobación):      node migrar_identidades.mjs --aplicar --confirmo <huella>
// No borra nada. Conserva el valor original en campos *_principal. En eventos solo añade agenteCanonico (createdBy intacto, sin mover la guardia).
import { writeFileSync } from 'node:fs';
import { FirestoreStore } from './firestore-store.mjs';
import { readRegistry } from './registro-fuentes.mjs';
import { planificarIdentidades } from './migracion-identidades.mjs';
const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const leer = async col => { const rows = []; let cursor = null; for (;;) { const p = await store.list(col, { cursor, limit: 500 }); rows.push(...p); if (p.length < 500) break; cursor = p.at(-1).id; } return rows; };
const colecciones = { tablon_agentes: await leer('tablon_agentes'), tareas_agentes: await leer('tareas_agentes'), zonas_agentes: await leer('zonas_agentes'), tablon_lecturas: await leer('tablon_lecturas'), registro_fuentes: await readRegistry(store), eventos: await store.listAll('eventos', { max: 8000 }) };
const { informe, cambios, huella } = planificarIdentidades(colecciones);
informe.huella = huella; informe.modo = process.argv.includes('--aplicar') ? 'APLICAR' : 'ENSAYO (no se ha escrito nada)';
if (arg('salida')) writeFileSync(arg('salida'), JSON.stringify(informe, null, 2));
if (!process.argv.includes('--aplicar')) { console.log(JSON.stringify({ modo: informe.modo, huella, resumen: informe.resumen, eventos: informe.eventos, sinMapear: informe.sinMapear, porColeccion: informe.porColeccion }, null, 2)); process.exit(0); }
if (arg('confirmo') !== huella) { console.error(`Huella distinta o ausente (plan actual ${huella}): solo se aplica el plan aprobado en el ensayo.`); process.exit(2); }
const log = { campos: 0, metadatosEventos: 0, lecturas: 0, errores: [] };
for (const c of cambios) {
  try {
    if (c.tipo === 'campos') { const row = await store.get(c.coleccion, c.id); await store.write(c.coleccion, c.id, { ...row.data, ...c.set }, { updateTime: row.updateTime }); log.campos++; }
    else if (c.tipo === 'metadato_evento') { await store.write('eventos', c.id, c.set, { updateTime: c.updateTime, updateFields: Object.keys(c.set), metadataOnly: true }); log.metadatosEventos++; }
    else if (c.tipo === 'fusionar_lectura') { const dest = await store.get('tablon_lecturas', c.id), hilos = { ...(dest?.data.hilos || {}) }; for (const [h, t] of Object.entries(c.hilos)) if (!hilos[h] || hilos[h] < t) hilos[h] = t; await store.write('tablon_lecturas', c.id, { agente: c.id, hilos, actualizado_en: new Date().toISOString() }, dest ? { updateTime: dest.updateTime } : { create: true }); log.lecturas++; }
  } catch (e) { log.errores.push({ coleccion: c.coleccion, id: c.id, error: e.code || e.message }); }
}
console.log(JSON.stringify(log, null, 2));
