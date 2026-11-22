// migrar_fuentes.mjs — migración Sheet «Fuentes actuales amalia» + registro del MCP -> repositorio único (colección registro_fuentes).
//   ENSAYO (por defecto, NO escribe nada):  node migrar_fuentes.mjs --csv fuentes.csv [--salida informe.json] [--mapa '{"url":"Enlace"}']
//                                            node migrar_fuentes.mjs --hoja-id <id> --pestana Fuentes   (la hoja compartida con la cuenta de servicio)
//   APLICAR (solo con tu aprobación):        node migrar_fuentes.mjs ... --aplicar --confirmo <huella del informe aprobado>
// Nunca borra ni pisa valores existentes: crea fuentes nuevas (create:true) y solo rellena huecos de las existentes.
import { readFileSync, writeFileSync } from 'node:fs';
import { FirestoreStore } from './firestore-store.mjs';
import { readRegistry } from './registro-fuentes.mjs';
import { parseCsv, mapearCabeceras, filaDeHoja, planificar, documentoNuevo, huecosPorCompletar } from './migracion-fuentes.mjs';
import { leerPestana } from './google-sheets.mjs';

const arg = (k, def = null) => { const i = process.argv.indexOf('--' + k); return i < 0 ? def : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] == null ? true : process.argv[i + 1]); };
async function valoresHoja() {
  if (arg('csv')) return parseCsv(readFileSync(arg('csv'), 'utf8'));
  if (arg('hoja-id')) return leerPestana({ hojaId: arg('hoja-id'), pestana: arg('pestana', 'Fuentes'), credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
  return null;
}
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const aplicar = process.argv.includes('--aplicar');
const valores = await valoresHoja();
const registro = await readRegistry(store);
let filas = [], cabeceras = null;
if (valores) {
  const m = mapearCabeceras(valores[0] || [], arg('mapa') ? JSON.parse(arg('mapa')) : {});
  cabeceras = { detectadas: valores[0], mapeadas: m.mapa, sinMapear: m.sinMapear };
  filas = valores.slice(1).map((v, i) => filaDeHoja(v, m.mapa, i + 2)).filter(f => f.codigo || f.nombre || f.urlCruda);
}
const { informe, plan, huella } = planificar({ filas, registro, cabeceras });
informe.huella = huella; informe.modo = aplicar ? 'APLICAR' : 'ENSAYO (no se ha escrito nada)'; informe.hojaLeida = !!valores;
if (arg('salida')) writeFileSync(arg('salida'), JSON.stringify(informe, null, 2));
if (!aplicar) { console.log(JSON.stringify({ modo: informe.modo, huella, resumen: informe.resumen, cabeceras: informe.cabeceras }, null, 2)); process.exit(0); }

if (!valores) { console.error('Aplicar exige la hoja (--csv o --hoja-id).'); process.exit(2); }
if (arg('confirmo') !== huella) { console.error(`Huella distinta o ausente. El plan actual tiene huella ${huella}; solo se aplica el plan que aprobaste en el ensayo (--confirmo <huella>).`); process.exit(2); }
const ahora = new Date().toISOString(), log = { creadas: [], completadas: [], omitidas: [], errores: [] };
for (const p of plan) {
  try {
    if (p.accion === 'crear') {
      const { id, data } = documentoNuevo(p.filas, { ahora });
      if (await store.get('registro_fuentes', id)) { log.omitidas.push({ id, motivo: 'ya existe' }); continue; }
      await store.write('registro_fuentes', id, data, { create: true }); log.creadas.push({ id, codigo: data.codigo });
    } else {
      const row = await store.get('registro_fuentes', p.fuenteId), set = huecosPorCompletar(row.data, p.filas);
      if (!Object.keys(set).length) { log.omitidas.push({ id: p.fuenteId, motivo: 'sin huecos' }); continue; }
      const d = { ...row.data, ...set, modificada_por: 'migracion', modificada_en: ahora, historial: [...(row.data.historial || []), { en: ahora, por: 'migracion', motivo: 'Migración de la hoja «Fuentes actuales amalia»', cambios: Object.entries(set).map(([campo, despues]) => ({ campo, antes: row.data[campo] ?? null, despues })) }].slice(-25) };
      await store.write('registro_fuentes', p.fuenteId, d, { updateTime: row.updateTime }); log.completadas.push({ id: p.fuenteId, campos: Object.keys(set) });
    }
  } catch (e) { log.errores.push({ accion: p.accion, id: p.fuenteId || null, error: e.code || e.message }); }
}
if (arg('salida')) writeFileSync(String(arg('salida')).replace(/\.json$/, '') + '.aplicado.json', JSON.stringify(log, null, 2));
// Correcciones explícitas aprobadas (--correcciones archivo.json): [{fuenteId, campos:{...}, motivo}]. Solo campos de ubicación/ámbito; cada una deja historial.
if (arg('correcciones')) {
  const PERMITIDOS = new Set(['provincia', 'municipio', 'region', 'ambito', 'comarca', 'zona']);
  for (const c of JSON.parse(readFileSync(arg('correcciones'), 'utf8'))) {
    try {
      const row = await store.get('registro_fuentes', c.fuenteId); if (!row) { log.errores.push({ correccion: c.fuenteId, error: 'no existe' }); continue; }
      const campos = Object.fromEntries(Object.entries(c.campos).filter(([k]) => PERMITIDOS.has(k)));
      const d = { ...row.data, ...campos, modificada_por: 'migracion', modificada_en: ahora, historial: [...(row.data.historial || []), { en: ahora, por: 'migracion', motivo: c.motivo, cambios: Object.entries(campos).map(([campo, despues]) => ({ campo, antes: row.data[campo] ?? null, despues })) }].slice(-25) };
      await store.write('registro_fuentes', c.fuenteId, d, { updateTime: row.updateTime }); log.completadas.push({ id: c.fuenteId, correccion: Object.keys(campos) });
    } catch (e) { log.errores.push({ correccion: c.fuenteId, error: e.code || e.message }); }
  }
}
console.log(JSON.stringify({ modo: 'APLICADO', creadas: log.creadas.length, completadas: log.completadas.length, omitidas: log.omitidas.length, errores: log.errores.length }, null, 2));
