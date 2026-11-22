// reparar_ficha_sesiones.mjs <eventId> '<json sesiones>' [--aplicar]  — añade la lista de sesiones a una ficha YA creada (sin crear otra). ENSAYO por defecto.
import { FirestoreStore } from './firestore-store.mjs';
import { EventService } from './event-service.mjs';
import { normSesiones } from './event-domain.mjs';
const [eventId, json] = process.argv.slice(2), aplicar = process.argv.includes('--aplicar');
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const row = await store.get('eventos', eventId); if (!row) throw new Error('event_not_found');
const sesiones = normSesiones(JSON.parse(json)), d = row.data, fin = sesiones.at(-1).fechaLocal;
const plan = { eventId, titulo: d.titulo, versionActual: d.version, antes: { fechaLocal: d.fechaLocal, fechaFinLocal: d.fechaFinLocal ?? null, sesiones: d.sesiones ?? null }, despues: { fechaLocal: sesiones[0].fechaLocal, fechaFinLocal: fin, sesiones } };
if (!aplicar) { console.log(JSON.stringify({ modo: 'ENSAYO (no se ha escrito nada)', ...plan }, null, 2)); process.exit(0); }
const ev = new EventService(store, {}, { warm: false });
const out = await ev.update({ eventId, negocioId: d.negocioId, expectedVersion: d.version || 0, changes: { sesiones, fechaFinLocal: fin }, reason: 'Completar las sesiones de la ficha (admitir_candidato solo guardó la primera)', evidenciaUrl: d.fuentes?.[0]?.url }, { id: 'mantenimiento', agente: 'mantenimiento', actions: ['*'], businesses: ['*'] });
console.log(JSON.stringify({ modo: 'APLICADO', eventId, version: out.version, sesiones: out.sesiones?.length, fechaFinLocal: out.fechaFinLocal }, null, 2));
