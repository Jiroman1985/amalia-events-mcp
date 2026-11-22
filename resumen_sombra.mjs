// resumen_sombra.mjs — resume el log de la fase sombra (líneas {"event":"claves_sombra",...}) y marca posibles falsos positivos.
//   docker logs amalia-events-mcp 2>&1 | grep claves_sombra > sombra.log ; node resumen_sombra.mjs sombra.log
// Falso positivo (candidato a revisar): la sombra habría bloqueado/encolado un evento que SE CREÓ igualmente y sigue activo junto al evento con el que chocaba
// (nadie lo retiró): o eran sesiones distintas legítimas, o es un duplicado que se coló. Cada caso sale con los títulos para decidirlo a mano.
import { readFileSync } from 'node:fs';
import { FirestoreStore } from './firestore-store.mjs';
const lineas = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l.slice(l.indexOf('{'))); } catch { return null; } }).filter(x => x?.event === 'claves_sombra');
const porEvento = new Map();
for (const l of lineas) { const k = l.eventId; const peor = { libre: 0, cola: 1, bloquea: 2 }; const cur = porEvento.get(k); if (!cur || peor[l.claves] > peor[cur.claves]) porEvento.set(k, l); }
const total = porEvento.size, cuenta = { libre: 0, cola: 0, bloquea: 0 };
for (const l of porEvento.values()) cuenta[l.claves]++;
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const sospechosos = [];
for (const l of porEvento.values()) {
  if (l.claves === 'libre') continue;
  const ev = await store.get('eventos', l.eventId); if (!ev) continue;
  const vecinos = [];
  for (const id of l.coincidenciasClaves || []) { const v = await store.get('eventos', id); if (v) vecinos.push({ eventId: id, titulo: v.data.titulo, retirado: v.data.retirado === true }); }
  sospechosos.push({ decisionSombra: l.claves, eventId: l.eventId, titulo: ev.data.titulo, ciudad: ev.data.city, fecha: ev.data.fechaLocal, hora: ev.data.horaLocal || null, retirado: ev.data.retirado === true, creadoPor: ev.data.createdBy, vecinos, ambosActivos: ev.data.retirado !== true && vecinos.some(v => !v.retirado) });
}
const resumen = { llamadasRegistradas: lineas.length, eventosDistintosEvaluados: total, habriaBloqueado: cuenta.bloquea, habriaIdoALaCola: cuenta.cola, habriaDejadoPasar: cuenta.libre, retiradosDespues: sospechosos.filter(s => s.retirado || s.vecinos.some(v => v.retirado)).length, ambosSiguenActivos: sospechosos.filter(s => s.ambosActivos).length };
console.log(JSON.stringify({ resumen, casos: sospechosos }, null, 1));
