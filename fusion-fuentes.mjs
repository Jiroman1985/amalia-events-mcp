// fusion-fuentes.mjs — fusionar_fuentes: une una fuente duplicada con la que se queda. SOLO board_admin (Alfred).
// No borra nada: la duplicada queda en estado «fusionada» con enlace a la otra. Mueve sus eventos (campo fuenteId, con rastro) y sus alias/canales.
// modo=simular (por defecto) no escribe; aplicar exige el codigoConfirmacion de la simulación (cambia si cualquiera de los documentos cambia).
import { fail, hash } from './event-domain.mjs';
import { agenteCanonico } from './identidad.mjs';
import { adminTablon } from './tablon.mjs';

// Más restrictivo = más a la derecha. La fusión conserva siempre el más restrictivo de los dos.
export const RESTRICCION = ['descubierta', 'activa', 'en_comprobacion', 'pausada', 'descartada', 'bloqueada'];
const rango = e => { const i = RESTRICCION.indexOf(e ?? 'activa'); return i < 0 ? 1 : i; };
export const masRestrictivo = (a, b) => (rango(b) > rango(a) ? b : a) ?? 'activa';

const cod = (dup, dest, eventos) => hash(JSON.stringify({ d: [dup.id, dup.updateTime], t: [dest.id, dest.updateTime], e: eventos.map(e => [e.id, e.updateTime]).sort() })).slice(0, 12);

export async function fusionarFuentes(store, input, principal, { now = () => new Date().toISOString(), eventos = null } = {}) {
  adminTablon(principal);
  const dupId = String(input.fuenteDuplicada || '').trim(), destId = String(input.fuenteDestino || '').trim();
  if (!dupId || !destId) fail('fusion_fuentes_requeridas', { ayuda: 'Indica fuenteDuplicada (la que desaparece del uso) y fuenteDestino (la que se queda).' });
  if (dupId === destId) fail('fuente_fusion_invalida', { ayuda: 'No se puede fusionar una fuente consigo misma.' });
  const motivo = String(input.motivo || '').trim(); if (motivo.length < 5 || motivo.length > 500) fail('fusion_motivo_requerido', { ayuda: 'motivo: 5 a 500 caracteres.' });
  const modo = input.modo || 'simular'; if (!['simular', 'aplicar'].includes(modo)) fail('fusion_modo_invalido');
  const dup = await store.get('registro_fuentes', dupId), dest = await store.get('registro_fuentes', destId);
  if (!dup) fail('fuente_no_encontrada', { fuenteId: dupId }); if (!dest) fail('fuente_no_encontrada', { fuenteId: destId });
  for (const r of [dup, dest]) if (r.data.estado === 'fusionada') fail('fuente_fusionada', { fuenteId: r.id, fusionadaEn: r.data.fusionada_en || r.data.duplicado_de || null, ayuda: 'Esa fuente ya está fusionada; usa la fuente en la que se fusionó.' });
  const dd = dup.data, de = dest.data;
  const ids = new Set([dup.id, dd.codigo, ...(dd.codigos_alternativos || [])].filter(Boolean));
  const todos = eventos || await store.listAll('eventos', { max: 20000 });
  const movibles = todos.filter(e => ids.has(e.data?.fuenteId));
  const estado = masRestrictivo(de.estado, dd.estado);
  const sec = [...(de.canales_secundarios || [])]; const esta = (c, i) => (de.canal === c && de.identificador === i) || sec.some(x => x.canal === c && x.identificador === i);
  const aliasNuevos = [];
  for (const x of [{ canal: dd.canal, identificador: dd.identificador, url: dd.url || '', fuenteIdAnterior: dup.id }, ...(dd.canales_secundarios || [])]) if (x.canal && x.identificador && !esta(x.canal, x.identificador)) { const a = { canal: x.canal, identificador: x.identificador, url: x.url || '', añadido_en: now(), fuenteIdAnterior: x.fuenteIdAnterior || dup.id }; sec.push(a); aliasNuevos.push(a); }
  const codigosAlt = [...new Set([...(de.codigos_alternativos || []), ...(dd.codigo && dd.codigo !== de.codigo ? [dd.codigo] : []), dup.id, ...(dd.codigos_alternativos || [])].filter(c => c && c !== de.codigo))];
  const motivoBloqueo = estado === 'bloqueada' ? (de.estado === 'bloqueada' && de.motivo_bloqueo ? de.motivo_bloqueo : dd.motivo_bloqueo || de.motivo_bloqueo || null) : null;
  const codigoConfirmacion = cod(dup, dest, movibles);
  const plan = { fuenteDuplicada: { id: dup.id, codigo: dd.codigo || null, url: dd.url || null, estado: dd.estado || 'activa', eventosAportados: Number(dd.eventos_aportados) || 0 }, fuenteDestino: { id: dest.id, codigo: de.codigo || null, url: de.url || null, estadoActual: de.estado || 'activa', estadoResultante: estado, cambiaEstado: estado !== (de.estado || 'activa') }, eventosAMover: movibles.map(e => ({ eventId: e.id, titulo: e.data.titulo || e.data.nombre || null, fecha: e.data.fechaLocal || null, retirado: e.data.retirado === true })), aliasQueSeAñaden: aliasNuevos.map(a => ({ canal: a.canal, url: a.url })), codigosAlternativos: codigosAlt, codigoConfirmacion };
  if (modo === 'simular') return { vistaPrevia: true, escrito: false, ...plan, siguientePaso: `Repite con modo=aplicar y codigoConfirmacion=${codigoConfirmacion}. La duplicada NO se borra: queda «fusionada» con enlace a ${dest.id}.` };
  if (input.codigoConfirmacion !== codigoConfirmacion) fail('confirmation_mismatch', { ayuda: 'Los documentos cambiaron o el código no es el de la simulación: simula otra vez.' });
  const yo = agenteCanonico(principal.id), ahora = now(), movidos = [], errores = [];
  for (const e of movibles) {
    try { await store.write('eventos', e.id, { fuenteId: dest.id, fuenteIdAnterior: e.data.fuenteId, fuenteMovidaPor: yo, fuenteMovidaEn: ahora, fuenteMovidaMotivo: motivo }, { updateTime: e.updateTime, updateFields: ['fuenteId', 'fuenteIdAnterior', 'fuenteMovidaPor', 'fuenteMovidaEn', 'fuenteMovidaMotivo'], metadataOnly: true }); movidos.push(e.id); }
    catch (err) { errores.push({ eventId: e.id, error: err.code || err.message }); }
  }
  if (errores.length) return { aplicado: false, parcial: true, eventosMovidos: movidos, errores, aviso: 'Algún evento no se pudo mover: las fuentes NO se han modificado. Vuelve a simular y aplicar (los ya movidos no se repiten).' };
  const d = structuredClone(de), antesEstado = d.estado ?? null;
  d.estado = estado; if (motivoBloqueo) d.motivo_bloqueo = motivoBloqueo; if (sec.length) d.canales_secundarios = sec; if (codigosAlt.length) d.codigos_alternativos = codigosAlt;
  d.eventos_aportados = (Number(de.eventos_aportados) || 0) + (Number(dd.eventos_aportados) || 0);
  d.modificada_por = yo; d.modificada_por_principal = principal.id; d.modificada_en = ahora;
  d.historial = [...(d.historial || []), { en: ahora, por: yo, principal: principal.id, motivo, cambios: [{ campo: 'fusion', antes: null, despues: `absorbe ${dup.id}` }, ...(antesEstado !== estado ? [{ campo: 'estado', antes: antesEstado, despues: estado }] : []), { campo: 'eventos_movidos', antes: null, despues: movidos.length }] }].slice(-25);
  await store.write('registro_fuentes', dest.id, d, { updateTime: dest.updateTime });
  const o = structuredClone(dd);
  o.estado_anterior = dd.estado ?? 'activa'; o.estado = 'fusionada'; o.duplicado_de = dest.id; o.fusionada_en = dest.id; o.fusionada_por = yo; o.fusionada_el = ahora; o.eventos_movidos = movidos;
  o.modificada_por = yo; o.modificada_por_principal = principal.id; o.modificada_en = ahora;
  o.historial = [...(o.historial || []), { en: ahora, por: yo, principal: principal.id, motivo, cambios: [{ campo: 'estado', antes: dd.estado ?? null, despues: 'fusionada' }, { campo: 'duplicado_de', antes: null, despues: dest.id }] }].slice(-25);
  try { await store.write('registro_fuentes', dup.id, o, { updateTime: dup.updateTime }); }
  catch (err) { return { aplicado: true, avisoFusion: `La fuente destino y los eventos se actualizaron, pero la duplicada no se pudo marcar como fusionada (${err.code || err.message}). Repite la operación.`, eventosMovidos: movidos }; }
  return { aplicado: true, escrito: true, fuenteDuplicada: dup.id, fuenteDestino: dest.id, estadoResultante: estado, eventosMovidos: movidos, aliasAñadidos: aliasNuevos.length, mensaje: 'Fusión hecha. La duplicada se conserva como «fusionada» (enlazada a la destino); no se ha borrado nada.' };
}
