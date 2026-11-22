// cola-revision.mjs — cola `revisar_candidatos`: altas dudosas que NO crean ficha hasta que Alfred decide.
import { hash, fingerprint, fail } from './event-domain.mjs';
import { agenteCanonico } from './identidad.mjs';
export const COLA = 'revisar_candidatos';
export const colaId = (eventId, e) => 'rc_' + hash(eventId + '\0' + fingerprint(e)).slice(0, 40);
/** Idempotente: la misma propuesta dudosa siempre cae en el mismo elemento de la cola. */
export async function encolarRevision(store, { e, eventId: eventIdParam, input, principal, scan }) {
  const eventId = eventIdParam || null;
  const id = colaId(eventId || e.fuentes?.[0]?.url || e.titulo, e);
  const prior = await store.get(COLA, id);
  if (prior) return { id, ...prior.data, existente: true };
  const sesiones = Array.isArray(e.sesiones) && e.sesiones.length ? e.sesiones : [{ fechaLocal: e.fechaLocal, horaLocal: e.horaLocal || null }];
  const data = { estado: 'pendiente', negocioId: e.negocioId, titulo: e.titulo, city: e.city || null, lugar: e.lugar || null, fechaLocal: e.fechaLocal || null, horaLocal: e.horaLocal || null, sesiones, evento: input, coincidencias: scan.coincidencias, claves: scan.claves || null, solicitadoPor: agenteCanonico(principal.id), solicitadoPorPrincipal: principal.id, creadoEn: new Date().toISOString(), version: 1 };
  try { await store.write(COLA, id, data, { create: true }); } catch (err) { if (err.code !== 'version_conflict') throw err; }
  return { id, ...data };
}
export const resumenCola = r => ({ colaId: r.id, estado: r.data.estado, titulo: r.data.titulo, city: r.data.city, lugar: r.data.lugar, fechaLocal: r.data.fechaLocal, horaLocal: r.data.horaLocal, solicitadoPor: r.data.solicitadoPor, creadoEn: r.data.creadoEn, coincidencias: r.data.coincidencias, resolucion: r.data.resolucion || null });
