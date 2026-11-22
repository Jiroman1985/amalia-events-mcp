// tareas.mjs — tareas de los agentes (colección `tareas_agentes`): qué hace cada agente ahora y qué hará después.
// Obligación de los agentes: mantenerlas al día con `board`. Alfred (`board_admin`) puede crearlas o modificarlas para otro agente.
import { randomBytes } from 'node:crypto';
import { fail, authorize } from './event-domain.mjs';
import { agenteDe, esAdminTablon } from './tablon.mjs';
import { agenteCanonico } from './identidad.mjs';

export const COL = 'tareas_agentes';
export const ESTADOS = ['en_curso', 'siguiente', 'bloqueada', 'hecha', 'cancelada'];
export const AGENTES_CONOCIDOS = ['alfred', 'alfie', 'conchi', 'amalia', 'hark', 'lola'];
const MAX_EN_CURSO = 5, MAX_SIGUIENTES = 40, HORAS_SIN_ACTUALIZAR = 24, DIAS_HECHAS = 7;
const AGENTE_RE = /^[a-z0-9_-]{2,40}$/, HORA_MS = 3600000, DIA_MS = 86400000;
const TRANSICIONES = { siguiente: ['en_curso', 'cancelada', 'bloqueada'], en_curso: ['hecha', 'bloqueada', 'siguiente', 'cancelada'], bloqueada: ['en_curso', 'siguiente', 'cancelada'], hecha: [], cancelada: [] };
const recientes = new Map();
const puede = (p, a) => { try { authorize(p, null, a); return true; } catch { return false; } };
const leer = p => { if (!puede(p, 'board') && !puede(p, 'board_read')) authorize(p, null, 'board'); };
const text = (v, min, max, code) => { if (typeof v !== 'string') fail(code); const s = v.replace(/\r\n/g, '\n').trim(); if (s.length < min || s.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) fail(code, { minimo: min, maximo: max }); return s; };
const limita = p => { const t = Date.now(), l = (recientes.get(p.id) || []).filter(x => t - x < 600000); if (l.length >= 60) fail('board_rate_limited', { ayuda: 'Máximo 60 operaciones de tareas cada 10 minutos por agente.' }); l.push(t); recientes.set(p.id, l); };
const nuevoId = () => 'tsk_' + Date.now().toString(36).padStart(9, '0') + randomBytes(3).toString('hex');
async function todas(store) { const rows = []; let cursor = null; for (;;) { const page = await store.list(COL, { cursor, limit: 500 }); if (!Array.isArray(page)) fail('incomplete_scan'); rows.push(...page.map(r => ({ ...r, data: { ...r.data, agente: agenteCanonico(r.data.agente) } }))); if (rows.length > 20000) fail('incomplete_scan'); if (page.length < 500) break; cursor = page.at(-1).id; } return rows; }
function referencias(r) {
  if (r == null) return null; if (typeof r !== 'object' || Array.isArray(r)) fail('tarea_referencias_invalidas');
  const out = {}, lista = (k, re) => { if (r[k] == null) return; if (!Array.isArray(r[k]) || r[k].length > 20 || r[k].some(x => typeof x !== 'string' || !re.test(x))) fail('tarea_referencias_invalidas', { campo: k }); out[k] = r[k]; };
  lista('fuenteIds', /^[A-Za-z0-9_-]{6,80}$/); lista('eventIds', /^[A-Za-z0-9_-]{6,80}$/);
  for (const k of ['zona', 'provincia', 'municipio']) if (r[k] != null) out[k] = text(r[k], 2, 120, 'tarea_referencias_invalidas');
  if (r.hilo != null) { if (typeof r.hilo !== 'string' || !/^msg_[a-z0-9]{6,30}$/.test(r.hilo)) fail('tarea_referencias_invalidas', { campo: 'hilo' }); out.hilo = r.hilo; }
  return Object.keys(out).length ? out : null;
}
const vista = d => ({ tareaId: d.id, agente: d.agente, titulo: d.titulo, detalle: d.detalle ?? null, estado: d.estado, prioridad: d.prioridad, orden: d.orden ?? null, progreso: d.progreso ?? null, motivoBloqueo: d.motivo_bloqueo ?? null, esperaA: d.espera_a ?? null, referencias: d.referencias ?? null, asignadaPor: d.asignada_por ?? null, creadaEn: d.creada_en, iniciadaEn: d.iniciada_en ?? null, terminadaEn: d.terminada_en ?? null, actualizadaEn: d.actualizada_en });
const activa = d => ['en_curso', 'siguiente', 'bloqueada'].includes(d.estado);

export async function publicarTarea(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  authorize(principal, null, 'board'); limita(principal);
  const yo = agenteDe(principal.id); let agente = yo;
  if (input.agente != null && String(input.agente).toLowerCase() !== yo) { if (!esAdminTablon(principal)) authorize(principal, null, 'board_admin'); agente = agenteCanonico(String(input.agente).toLowerCase().trim()); if (!AGENTE_RE.test(agente)) fail('tarea_agente_invalido'); }
  const estado = input.estado || 'siguiente'; if (!['en_curso', 'siguiente'].includes(estado)) fail('tarea_estado_invalido', { validos: ['en_curso', 'siguiente'], ayuda: 'Una tarea nueva empieza «en_curso» (la estás haciendo) o «siguiente» (la harás después).' });
  const propias = (await todas(store)).map(r => r.data).filter(d => d.agente === agente && activa(d));
  if (estado === 'en_curso' && propias.filter(d => d.estado === 'en_curso').length >= MAX_EN_CURSO) fail('tarea_limite_en_curso', { maximo: MAX_EN_CURSO, ayuda: 'Termina o devuelve a «siguiente» alguna tarea en curso antes de empezar otra.' });
  if (estado === 'siguiente' && propias.filter(d => d.estado === 'siguiente').length >= MAX_SIGUIENTES) fail('tarea_limite_siguientes', { maximo: MAX_SIGUIENTES });
  const t = now(), id = nuevoId();
  const d = { id, agente, titulo: text(input.titulo, 3, 140, 'tarea_titulo_invalido'), detalle: input.detalle ? text(input.detalle, 1, 1000, 'tarea_detalle_invalido') : null, estado, prioridad: input.prioridad === 'urgente' ? 'urgente' : 'normal', orden: estado === 'siguiente' ? Math.max(0, ...propias.filter(x => x.estado === 'siguiente').map(x => x.orden || 0)) + 1 : null, progreso: null, motivo_bloqueo: null, referencias: referencias(input.referencias), creada_por: yo, creada_por_principal: principal.id, asignada_por: agente !== yo ? yo : null, creada_en: t, iniciada_en: estado === 'en_curso' ? t : null, terminada_en: null, actualizada_en: t, historial: [{ en: t, por: yo, principal: principal.id, de: null, a: estado, nota: null }] };
  await store.write(COL, id, d, { create: true });
  return { publicada: true, ...vista(d) };
}

export async function actualizarTarea(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  authorize(principal, null, 'board'); limita(principal);
  for (let intento = 0; intento < 2; intento++) {
    const row = await store.get(COL, input.tareaId); if (!row) fail('tarea_no_encontrada', { tareaId: input.tareaId });
    const d = structuredClone(row.data); d.agente = agenteCanonico(d.agente); const yo = agenteDe(principal.id), admin = esAdminTablon(principal);
    if (d.agente !== yo && !admin) fail('forbidden', { ayuda: 'Solo el agente de la tarea o Alfred pueden modificarla.' });
    const t = now(), cambios = []; let nota = input.nota ? text(input.nota, 1, 500, 'tarea_nota_invalida') : null;
    if (input.titulo != null) { d.titulo = text(input.titulo, 3, 140, 'tarea_titulo_invalido'); cambios.push('titulo'); }
    if (input.detalle !== undefined) { d.detalle = input.detalle ? text(input.detalle, 1, 1000, 'tarea_detalle_invalido') : null; cambios.push('detalle'); }
    if (input.prioridad != null) { d.prioridad = input.prioridad === 'urgente' ? 'urgente' : 'normal'; cambios.push('prioridad'); }
    if (input.progreso != null) { if (!Number.isInteger(input.progreso) || input.progreso < 0 || input.progreso > 100) fail('tarea_progreso_invalido', { ayuda: 'Entero de 0 a 100.' }); d.progreso = input.progreso; cambios.push('progreso'); }
    if (input.referencias !== undefined) { d.referencias = referencias(input.referencias); cambios.push('referencias'); }
    const antes = d.estado;
    if (input.estado && input.estado !== antes) {
      if (!ESTADOS.includes(input.estado)) fail('tarea_estado_invalido', { validos: ESTADOS });
      if (!TRANSICIONES[antes].includes(input.estado) && !(admin && antes === 'hecha')) fail('tarea_transicion_invalida', { de: antes, permitidas: TRANSICIONES[antes], ayuda: antes === 'hecha' || antes === 'cancelada' ? 'Una tarea terminada no se reabre: crea una nueva.' : undefined });
      if (input.estado === 'en_curso') { const n = (await todas(store)).filter(r => r.data.agente === d.agente && r.data.estado === 'en_curso' && r.id !== d.id).length; if (n >= MAX_EN_CURSO) fail('tarea_limite_en_curso', { maximo: MAX_EN_CURSO }); d.iniciada_en = d.iniciada_en || t; }
      if (input.estado === 'bloqueada') { const mb = input.motivoBloqueo; if (typeof mb !== 'string' || mb.trim().length < 5) fail('tarea_motivo_bloqueo_requerido', { ayuda: 'Indica por qué está bloqueada y quién tiene que desbloquearla (≥5 caracteres).' }); d.motivo_bloqueo = text(mb, 5, 500, 'tarea_motivo_bloqueo_requerido'); d.espera_a = input.esperaA ? text(input.esperaA, 2, 80, 'tarea_espera_a_invalido') : null; } else { d.motivo_bloqueo = null; d.espera_a = null; }
      if (['hecha', 'cancelada'].includes(input.estado)) { d.terminada_en = t; d.orden = null; if (input.estado === 'hecha') d.progreso = 100; }
      if (input.estado === 'siguiente' && d.orden == null) d.orden = Math.max(0, ...(await todas(store)).filter(r => r.data.agente === d.agente && r.data.estado === 'siguiente').map(r => r.data.orden || 0)) + 1;
      if (input.estado !== 'siguiente' && input.estado !== 'en_curso' && input.estado !== 'bloqueada') d.orden = null;
      d.estado = input.estado; cambios.push('estado');
    } else if (input.motivoBloqueo && d.estado === 'bloqueada') { d.motivo_bloqueo = text(input.motivoBloqueo, 5, 500, 'tarea_motivo_bloqueo_requerido'); cambios.push('motivo_bloqueo'); }
    if (input.esperaA !== undefined && d.estado === 'bloqueada' && !(input.estado && input.estado !== antes)) { d.espera_a = input.esperaA ? text(input.esperaA, 2, 80, 'tarea_espera_a_invalido') : null; cambios.push('espera_a'); }
    if (!cambios.length && !nota) return { actualizada: false, ...vista(d), mensaje: 'No hay cambios.' };
    d.actualizada_en = t; d.historial = [...(d.historial || []), { en: t, por: yo, principal: principal.id, de: antes, a: d.estado, cambios, nota }].slice(-30);
    try { await store.write(COL, row.id, d, { updateTime: row.updateTime }); return { actualizada: true, ...vista(d) }; }
    catch (e) { if (e.code !== 'version_conflict' || intento === 1) throw e; }
  }
}

const orden = (a, b) => { const r = { en_curso: 0, bloqueada: 1, siguiente: 2, hecha: 3, cancelada: 4 }; if (r[a.estado] !== r[b.estado]) return r[a.estado] - r[b.estado]; if (a.estado === 'siguiente') return (a.orden || 0) - (b.orden || 0); return a.actualizada_en < b.actualizada_en ? 1 : -1; };
export async function listarTareas(store, input, principal, { ahora = Date.now() } = {}) {
  leer(principal); const ag = input.agente ? agenteCanonico(String(input.agente).toLowerCase()) : null, corte = ahora - DIAS_HECHAS * DIA_MS;
  let ts = (await todas(store)).map(r => r.data);
  if (ag) ts = ts.filter(d => d.agente === ag);
  if (input.estado === 'activas') ts = ts.filter(activa); else if (input.estado) ts = ts.filter(d => d.estado === input.estado);
  else ts = ts.filter(d => activa(d) || (input.incluirTerminadas === true) || (d.estado === 'hecha' && Date.parse(d.terminada_en) >= corte));
  if (input.desde) ts = ts.filter(d => d.actualizada_en >= input.desde);
  ts.sort(orden); const lim = Math.min(Math.max(input.limite || 200, 1), 500);
  return { total: ts.length, devueltas: Math.min(ts.length, lim), tareas: ts.slice(0, lim).map(vista) };
}
export async function misTareas(store, principal, opts) { leer(principal); return { agente: agenteDe(principal.id), ...(await listarTareas(store, { agente: agenteDe(principal.id) }, principal, opts)) }; }

/** Resumen por agente para el dashboard: qué hace ahora, qué viene y quién no ha publicado o actualizado nada. */
export async function resumenTareas(store, principal, { ahora = Date.now() } = {}) {
  leer(principal); const ts = (await todas(store)).map(r => r.data), por = new Map(AGENTES_CONOCIDOS.map(a => [a, []]));
  for (const d of ts) (por.get(d.agente) || por.set(d.agente, []).get(d.agente)).push(d);
  const agentes = [...por].map(([agente, l]) => {
    const enCurso = l.filter(d => d.estado === 'en_curso'), sig = l.filter(d => d.estado === 'siguiente'), blq = l.filter(d => d.estado === 'bloqueada'), hechas = l.filter(d => d.estado === 'hecha' && Date.parse(d.terminada_en) >= ahora - DIAS_HECHAS * DIA_MS);
    const ult = l.map(d => d.actualizada_en).sort().at(-1) || null, horas = ult ? Math.floor((ahora - Date.parse(ult)) / HORA_MS) : null;
    const alerta = !enCurso.length && !sig.length && !blq.length ? 'sin_tareas_publicadas' : (horas != null && horas >= HORAS_SIN_ACTUALIZAR ? 'sin_actualizar_24h' : null);
    // Estado para el panel: «bloqueado» solo si algo depende del propio agente; lo que espera a otra persona no lo bloquea.
    const propias = blq.filter(d => !d.espera_a), esperando = blq.filter(d => d.espera_a);
    const estadoPanel = enCurso.length ? 'en_curso' : propias.length ? 'bloqueado' : (sig.length || esperando.length) ? 'en_pausa' : 'sin_tareas';
    return { agente, estadoPanel, enCurso: enCurso.map(d => ({ tareaId: d.id, titulo: d.titulo, progreso: d.progreso ?? null, desde: d.iniciada_en })), siguientes: sig.sort((a, b) => (a.orden || 0) - (b.orden || 0)).slice(0, 10).map(d => ({ tareaId: d.id, titulo: d.titulo, prioridad: d.prioridad })), totalSiguientes: sig.length, bloqueadas: blq.map(d => ({ tareaId: d.id, titulo: d.titulo, motivo: d.motivo_bloqueo, esperaA: d.espera_a ?? null })), hechasUltimos7Dias: hechas.length, ultimaActualizacion: ult, horasSinActualizar: horas, alerta };
  }).sort((a, b) => a.agente.localeCompare(b.agente));
  return { generado: new Date(ahora).toISOString(), agentes, conAlerta: agentes.filter(a => a.alerta).map(a => ({ agente: a.agente, alerta: a.alerta })) };
}
