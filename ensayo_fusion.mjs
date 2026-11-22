// ensayo_fusion.mjs <fuenteDuplicada> <fuenteDestino> — SOLO simula (no escribe). Informe JSON por stdout.
import { FirestoreStore } from './firestore-store.mjs';
import { fusionarFuentes } from './fusion-fuentes.mjs';
import { conIdentidad } from './identidad.mjs';
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const [a, b] = process.argv.slice(2);
console.log(JSON.stringify(await fusionarFuentes(store, { fuenteDuplicada: a, fuenteDestino: b, motivo: 'Ensayo de fusión (solo simulación)', modo: 'simular' }, conIdentidad({ id: 'alfred-altas', actions: ['board'], businesses: ['*'] })), null, 2));
