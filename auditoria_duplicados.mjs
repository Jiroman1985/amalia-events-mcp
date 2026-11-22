// auditoria_duplicados.mjs — auditoría nocturna de duplicados. Por defecto SOLO PROPONE (informe + cola); no retira nada.
//   Informe:                node auditoria_duplicados.mjs --salida informe.json
//   + cola de Alfred:       node auditoria_duplicados.mjs --encolar          (todos los dudosos, tipo auditoria_par en revisar_candidatos)
//                           node auditoria_duplicados.mjs --encolar-ids evA,evB   (todos los pares que implican esos eventos)
//                           node auditoria_duplicados.mjs --encolar-fuertes  (solo exactos seguros + choques de clave fuerte; con propuesta de qué ficha conservar)
//   + informe en Firestore: node auditoria_duplicados.mjs --guardar          (informes_duplicados/AAAA-MM-DD)
//   Retirada automática (FASE 2, solo con aprobación): --retirar --confirmo <huella>  (solo exactos seguros; conserva la ficha más completa)
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FirestoreStore } from './firestore-store.mjs';
import { EventService } from './event-service.mjs';
import { analizarDuplicados, elegirConservada } from './auditoria-duplicados.mjs';
import { hash } from './event-domain.mjs';
import { setAliasDinamico } from './clave-sesion.mjs';
const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
setAliasDinamico((await store.list('municipio_alias', { limit: 500 }).catch(() => [])).map(r => r.data));
const rows = await store.listAll('eventos', { max: 50000 });
const { exactos, dudosos, sesiones, eventos } = analizarDuplicados(rows);
const hoy = new Date().toISOString().slice(0, 10);
const huella = createHash('sha256').update(JSON.stringify(exactos.map(p => [p.a, p.b]).sort())).digest('hex').slice(0, 16);
const informe = { fecha: hoy, generado: new Date().toISOString(), modo: arg('retirar') ? 'RETIRA' : 'PROPONE (no se ha retirado nada)', huella, resumen: { eventosActivos: eventos, sesiones, exactosSeguros: exactos.length, dudosos: dudosos.length }, exactos, dudosos };
if (arg('salida')) writeFileSync(arg('salida'), JSON.stringify(informe, null, 2));
const log = { encolados: 0, guardado: false, retiradas: [], errores: [] };
if (arg('guardar')) { try { await store.write('informes_duplicados', hoy, informe, { create: true }); log.guardado = true; } catch (e) { const cur = await store.get('informes_duplicados', hoy); await store.write('informes_duplicados', hoy, informe, { updateTime: cur.updateTime }); log.guardado = true; } }
const fuertes = [...exactos.map(p => ({ ...p, exacto: true })), ...dudosos.filter(p => p.motivos.some(m => m.startsWith('misma_clave')))];
const ids = new Set(String(arg('encolar-ids') || '').split(',').filter(Boolean));
const aEncolar = ids.size ? [...exactos.map(p => ({ ...p, exacto: true })), ...dudosos].filter(p => ids.has(p.a) || ids.has(p.b)) : arg('encolar-fuertes') ? fuertes : arg('encolar') ? dudosos : [];
const porId = new Map(rows.map(r => [r.id, r]));
for (const p of aEncolar) {
  const id = 'rc_' + hash('par\0' + [p.a, p.b].sort().join('>')).slice(0, 40);
  if (await store.get('revisar_candidatos', id)) continue;
  try { await store.write('revisar_candidatos', id, { tipo: 'auditoria_par', estado: 'pendiente', exactoSeguro: p.exacto === true, propuesta: (() => { const [k, o] = elegirConservada(porId.get(p.a), porId.get(p.b)); return { conservar: k.id, retirar: o.id, criterio: 'ficha más completa' }; })(), a: p.a, b: p.b, titulos: p.titulos, motivos: p.motivos, clave: p.clave, solicitadoPor: 'auditoria-nocturna', creadoEn: new Date().toISOString(), version: 1 }, { create: true }); log.encolados++; } catch (e) { log.errores.push({ id, error: e.code || e.message }); }
}
if (arg('retirar')) {
  if (arg('confirmo') !== huella) { console.error(`Huella distinta o ausente (plan actual ${huella}): solo se aplica el plan aprobado.`); process.exit(2); }
  const svc = new EventService(store, null, { claves: 'bloquea', warm: false }), sistema = { id: 'auditoria-nocturna', actions: ['*'], businesses: ['*'] };
  const por = new Map(rows.map(r => [r.id, r]));
  for (const p of exactos) { const [k, o] = elegirConservada(por.get(p.a), por.get(p.b)); try { log.retiradas.push(await svc.fusionarPar({ conservarId: k.id, retirarId: o.id, motivo: 'Auditoría nocturna: duplicado exacto (misma clave de sesión y título equivalente)' }, sistema)); } catch (e) { log.errores.push({ par: [p.a, p.b], error: e.code || e.message }); } }
}
console.log(JSON.stringify({ ...informe.resumen, huella, modo: informe.modo, ...log }, null, 1));
