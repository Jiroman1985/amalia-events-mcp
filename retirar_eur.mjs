// Retira (lógico, recuperable) todos los documentos «EUR Test Event» aprobados por el usuario. Simula salvo --aplicar.
import { FirestoreStore } from './firestore-store.mjs';
import { EventService } from './event-service.mjs';
const APLICAR = process.argv.includes('--aplicar'), piezas = new Set(JSON.parse(process.env.EVENTOS_CON_PIEZAS || '[]'));
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const events = new EventService(store, {});
const rows = []; let c = null;
for (;;) { const p = await store.list('eventos', { cursor: c, limit: 500 }); rows.push(...p); if (p.length < 500) break; c = p.at(-1).id; }
const objetivo = rows.filter(r => (r.data.titulo || r.data.nombre) === 'EUR Test Event' && r.data.retirado !== true && !piezas.has(r.id));
console.log(JSON.stringify({ modo: APLICAR ? 'APLICAR' : 'simulación', objetivo: objetivo.length, negocios: [...new Set(objetivo.map(r => r.data.negocioId))] }));
if (!APLICAR) process.exit(0);
const lim = { id: 'limpieza-catalogo', actions: ['retire'], businesses: ['*'] }, res = { retirados: 0, errores: [] };
for (const r of objetivo) { try { const v = await events.retirePreview({ eventId: r.id, negocioId: r.data.negocioId }, lim); await events.retire({ eventId: r.id, negocioId: r.data.negocioId, expectedVersion: v.versionActual, codigoConfirmacion: v.codigoConfirmacion, motivo: 'Evento de prueba «EUR Test Event» (limpieza única aprobada, 13-11-2026)' }, lim); res.retirados++; } catch (e) { res.errores.push({ id: r.id, error: e.code || String(e) }); } }
console.log('RESULTADO ' + JSON.stringify(res));
