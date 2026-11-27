// rellenar_urls_fuente.mjs — rellena urlsFuente/sourceIdsFuente en `eventos` y deja la marca que habilita la ruta indexada de buscar_duplicados_global.
//   node rellenar_urls_fuente.mjs             ENSAYO (no escribe): cuántos faltan
//   node rellenar_urls_fuente.mjs --aplicar   escribe solo esos dos campos (no mueve la guardia) y, si no queda ninguno, marca amalia_catalog_guard/indice_urls
// ANTES de aplicar: el servidor y TODO escritor externo de `eventos` que ponga `fuentes` deben escribir ya estos campos (AMALIA_DUP_INDEXADO=1); si no, no marques.
import { FirestoreStore, camposIndiceFuentes } from './firestore-store.mjs';
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const aplicar = process.argv.includes('--aplicar');
const igual = (a, b) => Array.isArray(a) && a.length === b.length && b.every(x => a.includes(x));
const pendientes = async () => (await store.listAll('eventos', { max: 100000 })).filter(r => { const c = camposIndiceFuentes(r.data); return (c.urlsFuente.length || c.sourceIdsFuente.length) && !(igual(r.data.urlsFuente, c.urlsFuente) && igual(r.data.sourceIdsFuente, c.sourceIdsFuente)); });
const lista = await pendientes();
if (!aplicar) { console.log(JSON.stringify({ modo: 'ENSAYO (no se ha escrito nada)', pendientes: lista.length })); process.exit(0); }
let escritos = 0; const errores = [];
for (const r of lista) {
  try { await store.write('eventos', r.id, camposIndiceFuentes(r.data), { updateTime: r.updateTime, updateFields: ['urlsFuente', 'sourceIdsFuente'], metadataOnly: true }); escritos++; }
  catch (e) { errores.push({ eventId: r.id, error: e.code || e.message }); }
}
const quedan = (await pendientes()).length;
if (!quedan) {
  const marca = await store.get('amalia_catalog_guard', 'indice_urls'), data = { completo: true, at: new Date().toISOString() };
  await store.write('amalia_catalog_guard', 'indice_urls', data, marca ? { updateTime: marca.updateTime } : { create: true });
}
console.log(JSON.stringify({ escritos, errores, quedan, marcado: !quedan }, null, 1));
