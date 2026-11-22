// rellenar_claves.mjs — crea/reconcilia sesiones_clave de los eventos activos. ENSAYO por defecto (no escribe).
//   node rellenar_claves.mjs --salida plan.json
//   node rellenar_claves.mjs --aplicar --confirmo <huella> [--sin-liberar | --solo-liberar] [--excluir evId,evId]   (dos pasos: primero crear/actualizar, verificar, y luego liberar las viejas)
// La cuenta de servicio NO puede borrar documentos: una clave que sobra se LIBERA (estado:'liberada'), no se borra. No toca `eventos` ni la guardia. Si dos eventos activos comparten clave FUERTE, solo uno la obtiene (el más completo) y el otro queda listado en `choques` (resolver antes de activar el bloqueo).
// Idempotente: se puede repetir justo antes de activar AMALIA_CLAVES=bloquea para reconciliar cambios hechos en modo sombra.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FirestoreStore } from './firestore-store.mjs';
import { clavesDeEvento } from './clave-sesion.mjs';
import { completitud } from './auditoria-duplicados.mjs';
const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const eventos = await store.listAll('eventos', { max: 50000 });
const existentes = new Map((await store.listAll('sesiones_clave', { max: 100000 })).map(r => [r.id, r]));
const deseadas = new Map(), choques = [];
for (const r of [...eventos].sort((a, b) => completitud(b.data) - completitud(a.data) || (a.id < b.id ? -1 : 1))) {
  const d = r.data || {}; if (d.retirado === true) continue;
  for (const c of clavesDeEvento(r.id, d)) { const prev = deseadas.get(c.id); if (prev && prev.data.eventId !== r.id) { choques.push({ clave: c.data.clave, conserva: prev.data.eventId, sinClave: r.id }); continue; } deseadas.set(c.id, c); }
}
const crear = [], borrar = [], cambiar = [];
for (const [id, c] of deseadas) { const e = existentes.get(id); if (!e) crear.push(c); else if (e.data.estado === 'liberada' || e.data.eventId !== c.data.eventId || e.data.titulo !== c.data.titulo || e.data.hora !== c.data.hora || e.data.recinto !== c.data.recinto) cambiar.push(c); }
for (const [id, e] of existentes) if (!deseadas.has(id) && e.data.estado !== 'liberada') borrar.push(id);
const huella = createHash('sha256').update(JSON.stringify([crear.map(c => c.id).sort(), borrar.sort(), cambiar.map(c => c.id).sort()])).digest('hex').slice(0, 16);
const informe = { modo: arg('aplicar') ? 'APLICAR' : 'ENSAYO (no se ha escrito nada)', huella, resumen: { eventosActivos: eventos.filter(r => r.data?.retirado !== true).length, clavesDeseadas: deseadas.size, existentes: existentes.size, crear: crear.length, cambiar: cambiar.length, liberar: borrar.length, choques: choques.length }, choques };
if (arg('salida')) writeFileSync(arg('salida'), JSON.stringify(informe, null, 2));
if (!arg('aplicar')) { console.log(JSON.stringify(informe, null, 1)); process.exit(0); }
if (arg('confirmo') !== huella) { console.error(`Huella distinta o ausente (plan actual ${huella}): solo se aplica el plan aprobado en el ensayo.`); process.exit(2); }
const soloLiberar = !!arg('solo-liberar'), sinLiberar = !!arg('sin-liberar');
const log = { creadas: 0, actualizadas: 0, liberadas: 0, errores: [] };
const guarda = async (fn, k) => { try { await fn(); log[k]++; } catch (e) { log.errores.push({ error: e.code || e.message }); } };
if (!soloLiberar) for (const c of crear) await guarda(() => store.write('sesiones_clave', c.id, { ...c.data, estado: 'activa' }, { create: true }), 'creadas');
if (!soloLiberar) for (const c of cambiar) await guarda(async () => { const cur = await store.get('sesiones_clave', c.id); await store.write('sesiones_clave', c.id, { ...c.data, estado: 'activa' }, { updateTime: cur.updateTime }); }, 'actualizadas');
const excluir = new Set(String(arg('excluir') || '').split(',').filter(Boolean));
if (!sinLiberar) for (const id of borrar) await guarda(async () => { const cur = await store.get('sesiones_clave', id); if (excluir.has(cur.data.eventId)) { log.omitidasPorExcluir = (log.omitidasPorExcluir || 0) + 1; return; } await store.write('sesiones_clave', id, { ...cur.data, estado: 'liberada', eventIdAnterior: cur.data.eventId || null, eventId: null, liberadaEn: new Date().toISOString() }, { updateTime: cur.updateTime }); }, 'liberadas');
console.log(JSON.stringify(log, null, 1));
