// cola-admision.mjs — cola persistente de altas que no se pudieron completar por un fallo de plataforma. Colección `cola_admision`.
// El candidato (evento + requestId + motivo) queda guardado en el servidor: el agente no necesita guardarlo en /tmp ni esperar aviso. Idempotente por (principal, requestId).
import { hash, fingerprint, fail, id as idOf } from './event-domain.mjs';
import { agenteCanonico } from './identidad.mjs';

export const COL = 'cola_admision';
export const ESTADOS = ['pendiente', 'reanudada', 'omitida_duplicado', 'rechazada', 'bloqueada'];
const MAX_INTENTOS = () => Number(process.env.AMALIA_COLA_MAX_INTENTOS || 20);

/** requestId estable del candidato: el del agente o uno derivado del contenido (así encolar dos veces lo mismo no duplica). */
export function requestIdDe(evento) {
  const { procedenciaRegistro, requestId, idempotencyKey, ...contenido } = evento || {};
  return String(requestId || idempotencyKey || 'q_' + fingerprint(contenido).slice(0, 32)).slice(0, 128);
}
export const colaIdDe = (principalId, requestId) => 'cq_' + hash(principalId + '\0' + requestId).slice(0, 40);

export async function encolar(store, { principal, evento, motivo, detalle = null, now = () => new Date().toISOString() }) {
  if (!evento || typeof evento !== 'object') fail('invalid_field', { campo: 'evento' });
  const requestId = requestIdDe(evento), colaId = colaIdDe(principal.id, requestId), t = now();
  const prior = await store.get(COL, colaId);
  if (prior) {
    if (prior.data.estado !== 'pendiente') return { colaId, requestId, yaEncolado: true, estado: prior.data.estado };
    await store.write(COL, colaId, { ...prior.data, ultimoMotivo: motivo, ultimoMotivoEn: t, version: (prior.data.version || 1) + 1 }, { updateTime: prior.updateTime }).catch(e => { if (e.code !== 'version_conflict') throw e; });
    return { colaId, requestId, yaEncolado: true, estado: 'pendiente' };
  }
  const data = { colaId, principal: principal.id, agente: agenteCanonico(principal.id), negocioId: evento.negocioId ?? null, titulo: evento.titulo ?? null, requestId, accion: 'admitir', evento: { ...evento, requestId }, motivo, ultimoMotivo: motivo, detalle, intentos: 0, estado: 'pendiente', creadaEn: t, ultimoMotivoEn: t, ultimoIntentoEn: null, eventId: null, version: 1 };
  await store.write(COL, colaId, data, { create: true }).catch(e => { if (e.code !== 'version_conflict') throw e; });
  return { colaId, requestId, yaEncolado: false, estado: 'pendiente' };
}

/** Todas las entradas (la cola es pequeña: se vacía sola). Más antiguas primero. */
export async function listar(store, { estado = null, agente = null, limite = 200 } = {}) {
  const rows = [];
  for (let cursor = null; ;) { const page = await store.list(COL, { cursor, limit: 200 }); if (!Array.isArray(page)) fail('incomplete_scan'); rows.push(...page); if (page.length < 200 || rows.length >= 5000) break; cursor = page.at(-1).id; }
  return rows.map(r => ({ id: r.id, updateTime: r.updateTime, ...r.data })).filter(x => (!estado || x.estado === estado) && (!agente || x.agente === agenteCanonico(agente))).sort((a, b) => (a.creadaEn < b.creadaEn ? -1 : a.creadaEn > b.creadaEn ? 1 : 0)).slice(0, limite);
}

export async function marcar(store, row, patch, { now = () => new Date().toISOString() } = {}) {
  const fresca = await store.get(COL, row.id); if (!fresca) return false;
  const next = { ...fresca.data, ...patch, version: (fresca.data.version || 1) + 1 };
  try { await store.write(COL, row.id, next, { updateTime: fresca.updateTime }); return true; } catch (e) { if (e.code === 'version_conflict') return false; throw e; }
}
export const superaIntentos = intentos => intentos >= MAX_INTENTOS();
export const resumenPorAgente = filas => { const o = {}; for (const f of filas) { if (f.estado !== 'pendiente') continue; const a = (o[f.agente] ||= { pendientes: 0, motivos: {}, masAntiguaEn: f.creadaEn }); a.pendientes++; a.motivos[f.ultimoMotivo] = (a.motivos[f.ultimoMotivo] || 0) + 1; } return o; };
