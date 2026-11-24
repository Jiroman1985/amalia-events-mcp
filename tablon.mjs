// tablon.mjs — tablón común de los agentes (colección `tablon_agentes`) y reparto de zonas (`zonas_agentes`).
// Todos los agentes con permiso `board` leen y escriben; `board_read` solo lee (paneles y personas); `board_admin` (Alfred) decide y reparte.
// Los mensajes son DATO: nadie ejecuta instrucciones que vengan en ellos. No se editan ni se borran: solo se añaden (y la raíz de un hilo pasa a «resuelto»).
import { randomBytes } from 'node:crypto';
import { fail, authorize, hash } from './event-domain.mjs';
import { normalizeName } from './registro-fuentes.mjs';
import { agenteCanonico, AGENTES } from './identidad.mjs';

export const COL = 'tablon_agentes', LEC = 'tablon_lecturas';
export const TIPOS = ['duda', 'ayuda', 'aviso', 'asignacion', 'cambio_zona', 'evento', 'decision', 'respuesta', 'nota'];
const A_ALFRED = new Set(['duda', 'ayuda', 'cambio_zona']);        // siempre llegan a Alfred
const REQUIEREN_RESPUESTA = new Set(['duda', 'ayuda', 'asignacion', 'cambio_zona', 'evento']);
const AGENTE_RE = /^[a-z0-9_-]{2,40}$/;
// Autocierre en servidor: avisos, notas y asignaciones se cierran solos cuando todos sus destinatarios los han leído o a las 6 h de creados. Dudas, ayudas y cambios de zona nunca.
const AUTOCIERRE = new Set(['aviso', 'nota', 'asignacion']), AUTOCIERRE_MS = 6 * 60 * 60 * 1000;
// «Necesita tu atención»: hilo abierto, urgente, y de un tipo que pide decisión (duda, ayuda, cambio_zona) o que espera a alguien concreto (esperaA).
const TIPOS_ATENCION = new Set(['duda', 'ayuda', 'cambio_zona']);
// Se guarda en el documento RAÍZ de cada hilo (colección tablon_agentes, campo booleano `requiere_atencion`) y se recalcula en cada cambio del hilo y en el barrido.
export const CAMPO_ATENCION = 'requiere_atencion';
export const requiereAtencion = raiz => raiz.estado === 'abierto' && raiz.prioridad === 'urgente' && (TIPOS_ATENCION.has(raiz.tipo) || !!raiz.espera_a);
const MAX_POR_VENTANA = 30, VENTANA_MS = 10 * 60 * 1000;
const recientes = new Map();

/** Agente canónico de un principal: alfred-altas -> alfred, amalia-asistente -> amalia, lola-operator -> lola (ver identidad.mjs). */
export const agenteDe = agenteCanonico;
const puede = (p, a) => { try { authorize(p, null, a); return true; } catch { return false; } };
const leer = p => { if (!puede(p, 'board') && !puede(p, 'board_read')) authorize(p, null, 'board'); };
const escribir = p => authorize(p, null, 'board');
// Alfred decide con cualquiera de sus tokens (que tengan board); además, board_admin explícito en el registro de acceso.
export const esAdminTablon = p => puede(p, 'board_admin') || (agenteCanonico(p?.id) === 'alfred' && puede(p, 'board'));
export const adminTablon = p => { if (!esAdminTablon(p)) authorize(p, null, 'board_admin'); };
const admin = adminTablon;
const text = (v, min, max, code) => { if (typeof v !== 'string') fail(code); const s = v.replace(/\r\n/g, '\n').trim(); if (s.length < min || s.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) fail(code, { minimo: min, maximo: max }); return s; };
const limita = p => { const t = Date.now(), l = (recientes.get(p.id) || []).filter(x => t - x < VENTANA_MS); if (l.length >= MAX_POR_VENTANA) fail('board_rate_limited', { ayuda: `Máximo ${MAX_POR_VENTANA} mensajes cada 10 minutos por agente.` }); l.push(t); recientes.set(p.id, l); };
const nuevoId = () => 'msg_' + Date.now().toString(36).padStart(9, '0') + randomBytes(3).toString('hex');

async function todos(store, col) { const rows = []; let cursor = null; for (;;) { const page = await store.list(col, { cursor, limit: 500 }); if (!Array.isArray(page)) fail('incomplete_scan'); rows.push(...page); if (rows.length > 20000) fail('incomplete_scan'); if (page.length < 500) break; cursor = page.at(-1).id; } return rows; }
function destinatarios(v, tipo, def) {
  let d = v == null ? def : v; if (!Array.isArray(d) || d.length < 1 || d.length > 12) fail('board_destinatarios_invalidos', { ayuda: 'Lista de 1 a 12 agentes (alfred, conchi, amalia, hark, lola, rene, noodle…) o ["todos"].' });
  d = [...new Set(d.map(x => agenteCanonico(String(x).toLowerCase().trim())))]; if (d.some(x => x !== 'todos' && !AGENTE_RE.test(x))) fail('board_destinatarios_invalidos');
  if (A_ALFRED.has(tipo) && !d.includes('alfred') && !d.includes('todos')) d.push('alfred');
  return d;
}
function referencias(r) {
  if (r == null) return null; if (typeof r !== 'object' || Array.isArray(r)) fail('board_referencias_invalidas');
  const out = {}, lista = (k, re) => { if (r[k] == null) return; if (!Array.isArray(r[k]) || r[k].length > 20 || r[k].some(x => typeof x !== 'string' || !re.test(x))) fail('board_referencias_invalidas', { campo: k }); out[k] = r[k]; };
  lista('fuenteIds', /^[A-Za-z0-9_-]{6,80}$/); lista('eventIds', /^[A-Za-z0-9_-]{6,80}$/);
  for (const k of ['zona', 'provincia', 'municipio']) if (r[k] != null) out[k] = text(r[k], 2, 120, 'board_referencias_invalidas');
  return Object.keys(out).length ? out : null;
}
const resumenHilo = raiz => ({ esperaA: raiz.espera_a ?? null, requiereAtencion: requiereAtencion(raiz), ...(raiz.estado === 'resuelto' ? { resueltoPor: raiz.resuelto_por ?? null, nota: raiz.nota ?? null } : {}) });
const resumenMsg = d => ({ id: d.id, hilo: d.hilo, autor: agenteCanonico(d.autor), agente: agenteCanonico(d.agente), principal: d.principal ?? null, tipo: d.tipo, asunto: d.asunto, texto: d.texto, destinatarios: d.destinatarios, prioridad: d.prioridad, referencias: d.referencias ?? null, creadoEn: d.creado_en, esRaiz: d.es_raiz === true });

export async function publicar(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  escribir(principal); limita(principal);
  if (!TIPOS.includes(input.tipo)) fail('board_tipo_invalido', { validos: TIPOS });
  if (input.tipo === 'decision') admin(principal);
  const id = nuevoId(), d = {
    id, hilo: id, es_raiz: true, autor: agenteDe(principal.id), principal: principal.id, agente: agenteDe(principal.id), tipo: input.tipo, asunto: text(input.asunto, 3, 120, 'board_asunto_invalido'), texto: text(input.texto, 1, 2000, 'board_texto_invalido'),
    destinatarios: destinatarios(input.destinatarios, input.tipo, A_ALFRED.has(input.tipo) ? ['alfred'] : ['todos']), prioridad: input.prioridad === 'urgente' ? 'urgente' : 'normal', estado: 'abierto', referencias: referencias(input.referencias), creado_en: now(),
    ...(input.esperaA ? { espera_a: text(input.esperaA, 2, 80, 'board_espera_a_invalido') } : {})
  };
  d.requiere_atencion = requiereAtencion(d);
  await store.write(COL, id, d, { create: true });
  return { publicado: true, id, hilo: id, autor: d.autor, destinatarios: d.destinatarios, mensaje: A_ALFRED.has(d.tipo) ? 'Mensaje publicado. Alfred decide en caso de duda: espera su respuesta antes de actuar.' : 'Mensaje publicado.' };
}

export async function responder(store, input, principal, { now = () => new Date().toISOString(), contar = true } = {}) {
  escribir(principal); if (contar) limita(principal);
  const raiz = await store.get(COL, input.hilo); if (!raiz || raiz.data.es_raiz !== true) fail('board_hilo_no_encontrado', { hilo: input.hilo });
  if (raiz.data.estado === 'resuelto' && !esAdminTablon(principal)) fail('board_hilo_resuelto', { ayuda: 'El hilo está resuelto: abre uno nuevo y referencia este, o pídeselo a Alfred.' });
  const tipo = input.tipo || 'respuesta'; if (!TIPOS.includes(tipo) || tipo === 'decision') fail('board_tipo_invalido', { validos: TIPOS.filter(t => t !== 'decision'), ayuda: 'Las decisiones las registra Alfred con decidir_hilo.' });
  const yo = agenteDe(principal.id), def = [...new Set([raiz.data.agente, ...raiz.data.destinatarios].filter(x => x && x !== yo))];
  const id = nuevoId(), d = { id, hilo: raiz.id, es_raiz: false, autor: yo, principal: principal.id, agente: yo, tipo, asunto: raiz.data.asunto, texto: text(input.texto, 1, 2000, 'board_texto_invalido'), destinatarios: destinatarios(input.destinatarios, tipo, def.length ? def : ['todos']), prioridad: raiz.data.prioridad, estado: 'abierto', referencias: referencias(input.referencias), creado_en: now() };
  await store.write(COL, id, d, { create: true });
  await recalcularSeguro(store, raiz.id);
  return { publicado: true, id, hilo: raiz.id, autor: d.autor, destinatarios: d.destinatarios };
}

async function lecturasDe(store, agente) { const r = await store.get(LEC, agente); return { row: r, hilos: r?.data?.hilos || {} }; }
function agrupar(rows) {
  const hilos = new Map();
  // Lectura robusta: aunque queden documentos antiguos con alias (alfred-altas…), todo se ve con el agente canónico.
  for (const r of rows) { const d = { ...r.data, autor: agenteCanonico(r.data.autor), agente: agenteCanonico(r.data.agente), destinatarios: (r.data.destinatarios || []).map(agenteCanonico) }; if (!d.hilo) continue; (hilos.get(d.hilo) || hilos.set(d.hilo, []).get(d.hilo)).push(d); }
  for (const l of hilos.values()) l.sort((a, b) => (a.creado_en < b.creado_en ? -1 : a.creado_en > b.creado_en ? 1 : a.id < b.id ? -1 : 1));
  return hilos;
}
const dirigidoA = (raiz, yo) => raiz.destinatarios.includes('todos') || raiz.destinatarios.includes(yo) || raiz.agente === yo || (yo === 'alfred' && A_ALFRED.has(raiz.tipo));

export async function listar(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  leer(principal); const yo = agenteDe(principal.id), hilos = agrupar(await todos(store, COL)); await autocerrarSeguro(store, hilos, now); const lect = await lecturasDe(store, yo);
  if (input.hilo) {
    const l = hilos.get(input.hilo); if (!l) fail('board_hilo_no_encontrado', { hilo: input.hilo });
    const r0 = l.find(x => x.es_raiz) || l[0];
    return { hilo: input.hilo, estado: r0.estado, asunto: r0.asunto, ...resumenHilo(r0), mensajes: l.map(resumenMsg) };
  }
  const desde = input.desde || null, out = [];
  for (const [id, l] of hilos) {
    const raiz = l.find(x => x.es_raiz) || l[0], ultimo = l.at(-1);
    if (input.tipo && raiz.tipo !== input.tipo) continue; if (input.estado && raiz.estado !== input.estado) continue; if (input.prioridad && raiz.prioridad !== input.prioridad) continue;
    if (input.autor && !l.some(x => x.agente === String(input.autor).toLowerCase() || x.autor === String(input.autor).toLowerCase())) continue;
    if (input.destinatario && !(raiz.destinatarios.includes(String(input.destinatario).toLowerCase()) || raiz.destinatarios.includes('todos'))) continue;
    if (input.zona && normalizeName(raiz.referencias?.zona) !== normalizeName(input.zona) && normalizeName(raiz.referencias?.provincia) !== normalizeName(input.zona)) continue;
    if (desde && ultimo.creado_en < desde) continue; if (input.soloMios && !dirigidoA(raiz, yo)) continue;
    const visto = lect.hilos[id] || '', sinLeer = l.filter(x => x.agente !== yo && x.creado_en > visto).length;
    if (input.soloSinLeer && !sinLeer) continue;
    out.push({ hilo: id, asunto: raiz.asunto, tipo: raiz.tipo, estado: raiz.estado, prioridad: raiz.prioridad, autor: raiz.agente, destinatarios: raiz.destinatarios, referencias: raiz.referencias ?? null, creadoEn: raiz.creado_en, mensajes: l.length, ultimo: { agente: ultimo.agente, creadoEn: ultimo.creado_en, resumen: ultimo.texto.slice(0, 160) }, sinLeer, ...resumenHilo(raiz) });
  }
  out.sort((a, b) => (a.ultimo.creadoEn < b.ultimo.creadoEn ? 1 : -1));
  const lim = Math.min(Math.max(input.limite || 50, 1), 200), off = Math.max(input.desplazamiento || 0, 0);
  return { total: out.length, requierenAtencion: out.filter(x => x.requiereAtencion).length, devueltos: Math.min(lim, Math.max(out.length - off, 0)), hayMas: off + lim < out.length, hilos: out.slice(off, off + lim) };
}

/** Lo que tengo que mirar: hilos abiertos dirigidos a mí con mensajes sin leer, o que esperan mi respuesta. */
export async function misPendientes(store, principal, { now = () => new Date().toISOString() } = {}) {
  leer(principal); const yo = agenteDe(principal.id), hilos = agrupar(await todos(store, COL)); await autocerrarSeguro(store, hilos, now); const lect = await lecturasDe(store, yo), items = [];
  for (const [id, l] of hilos) {
    const raiz = l.find(x => x.es_raiz) || l[0]; if (raiz.estado !== 'abierto' || !dirigidoA(raiz, yo)) continue;
    const visto = lect.hilos[id] || '', sinLeer = l.filter(x => x.agente !== yo && x.creado_en > visto).length;
    const yoRespondi = l.some(x => x.agente === yo && !x.es_raiz), esperaRespuesta = REQUIEREN_RESPUESTA.has(raiz.tipo) && raiz.agente !== yo && !yoRespondi && (raiz.destinatarios.includes(yo) || (yo === 'alfred' && A_ALFRED.has(raiz.tipo)));
    if (!sinLeer && !esperaRespuesta) continue;
    items.push({ hilo: id, asunto: raiz.asunto, tipo: raiz.tipo, prioridad: raiz.prioridad, autor: raiz.agente, sinLeer, esperaMiRespuesta: esperaRespuesta, ultimo: l.at(-1).creado_en, esperaA: raiz.espera_a ?? null, requiereAtencion: requiereAtencion(raiz) });
  }
  items.sort((a, b) => (a.prioridad === b.prioridad ? (a.ultimo < b.ultimo ? 1 : -1) : a.prioridad === 'urgente' ? -1 : 1));
  return { agente: yo, total: items.length, urgentes: items.filter(i => i.prioridad === 'urgente').length, requierenAtencion: items.filter(i => i.requiereAtencion).length, pendientes: items };
}

export async function marcarLeido(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  leer(principal); const yo = agenteDe(principal.id), hilos = agrupar(await todos(store, COL)), ids = input.todos === true ? [...hilos.keys()] : [input.hilo];
  if (!input.todos && (!input.hilo || !hilos.has(input.hilo))) fail('board_hilo_no_encontrado', { hilo: input.hilo || null });
  for (let intento = 0; intento < 3; intento++) {
    const { row, hilos: vistos } = await lecturasDe(store, yo), t = now(); const nuevo = { ...vistos }; for (const id of ids) nuevo[id] = t;
    try { await store.write(LEC, yo, { agente: yo, hilos: nuevo, actualizado_en: t }, row ? { updateTime: row.updateTime } : { create: true }); await autocerrarSeguro(store, hilos, now); await recalcularSeguro(store, null, hilos, ids); return { leido: ids.length, agente: yo }; }
    catch (e) { if (e.code !== 'version_conflict' || intento === 2) throw e; }
  }
}

/** Destinatarios que tienen que leer un hilo: los de la raíz («todos» = todos los agentes), sin el autor. */
const lectoresDe = raiz => [...new Set((raiz.destinatarios.includes('todos') ? AGENTES : raiz.destinatarios).map(agenteCanonico))].filter(x => x !== 'todos' && x !== raiz.agente);
/**
 * Cierra solos los hilos aviso/nota/asignacion abiertos cuando todos sus destinatarios los han leído (marca de lectura posterior al último mensaje de otros)
 * o han pasado 6 h desde su creación. resuelto_por «sistema», nota «autocierre». Nunca toca duda, ayuda, cambio_zona ni el resto de tipos.
 */
export async function autocerrar(store, { now = () => new Date().toISOString(), hilos = null } = {}) {
  hilos = hilos || agrupar(await todos(store, COL));
  const candidatos = [...hilos].filter(([, l]) => { const r = l.find(x => x.es_raiz) || l[0]; return r.estado === 'abierto' && AUTOCIERRE.has(r.tipo); });
  if (!candidatos.length) return [];
  const lect = new Map((await store.list(LEC, { limit: 500 })).map(r => [r.id, r.data?.hilos || {}])), ahora = Date.parse(now()), cerrados = [];
  for (const [id, l] of candidatos) {
    const raiz = l.find(x => x.es_raiz) || l[0], lectores = lectoresDe(raiz);
    const leido = lectores.length > 0 && lectores.every(r => { const ultimoAjeno = l.filter(x => x.agente !== r).at(-1); return !ultimoAjeno || (lect.get(r)?.[id] || '') >= ultimoAjeno.creado_en; });
    const vencido = ahora - Date.parse(raiz.creado_en) >= AUTOCIERRE_MS;
    if (!leido && !vencido) continue;
    const fresca = await store.get(COL, id); if (!fresca || fresca.data.estado !== 'abierto') continue;
    const t = now(), motivo = leido ? 'leido_por_todos' : 'seis_horas';
    try { await store.write(COL, id, { ...fresca.data, estado: 'resuelto', resuelto_por: 'sistema', resuelto_por_principal: 'sistema', resuelto_en: t, nota: 'autocierre', autocierre_motivo: motivo, requiere_atencion: false }, { updateTime: fresca.updateTime }); }
    catch (e) { if (e.code === 'version_conflict') continue; throw e; }
    raiz.estado = 'resuelto'; raiz.resuelto_por = 'sistema'; raiz.nota = 'autocierre'; raiz.requiere_atencion = false; cerrados.push({ hilo: id, motivo });
  }
  return cerrados;
}
// En lecturas y marcas de lectura el autocierre es de mejor esfuerzo: un fallo nunca rompe la consulta.
const autocerrarSeguro = async (store, hilos, now) => { try { await autocerrar(store, { now, hilos }); } catch { /* se reintenta en la siguiente lectura o barrido */ } };

/**
 * Recalcula `requiere_atencion` en el documento raíz de los hilos (todos, o solo `ids`) y escribe SOLO los que difieren de lo guardado.
 * Devuelve los ids corregidos. Se llama tras cada cambio del hilo y en el barrido.
 */
export async function recalcularAtencion(store, { hilos = null, ids = null } = {}) {
  hilos = hilos || agrupar(await todos(store, COL));
  const corregidos = [];
  for (const [id, l] of hilos) {
    if (ids && !ids.includes(id)) continue;
    const raiz = l.find(x => x.es_raiz); if (!raiz || raiz[CAMPO_ATENCION] === requiereAtencion(raiz)) continue;
    const fresca = await store.get(COL, id); if (!fresca || fresca.data.es_raiz !== true) continue;
    const v = requiereAtencion(fresca.data); if (fresca.data[CAMPO_ATENCION] === v) { raiz[CAMPO_ATENCION] = v; continue; }
    try { await store.write(COL, id, { ...fresca.data, [CAMPO_ATENCION]: v }, { updateTime: fresca.updateTime }); raiz[CAMPO_ATENCION] = v; corregidos.push(id); }
    catch (e) { if (e.code !== 'version_conflict') throw e; }
  }
  return corregidos;
}
/** Tras un cambio de un hilo concreto (o de varios, con su mapa en memoria): mejor esfuerzo, un fallo nunca rompe la operación; el barrido lo corrige. */
async function recalcularSeguro(store, hiloId, hilos = null, ids = null) {
  try {
    if (hiloId) { const raiz = await store.get(COL, hiloId); if (!raiz || raiz.data.es_raiz !== true) return; const v = requiereAtencion(raiz.data); if (raiz.data[CAMPO_ATENCION] !== v) await store.write(COL, hiloId, { ...raiz.data, [CAMPO_ATENCION]: v }, { updateTime: raiz.updateTime }); }
    else await recalcularAtencion(store, { hilos, ids });
  } catch { /* lo corrige el siguiente cambio o el barrido */ }
}
/** Plan puro (para el backfill): raíces cuyo `requiere_atencion` guardado falta o no coincide con el valor calculado. */
export function planAtencion(rows) {
  const raices = rows.filter(r => r.data?.es_raiz === true), cambios = raices.filter(r => r.data[CAMPO_ATENCION] !== requiereAtencion(r.data)).map(r => ({ id: r.id, antes: r.data[CAMPO_ATENCION] ?? null, despues: requiereAtencion(r.data) }));
  return { raices: raices.length, aTrue: raices.filter(r => requiereAtencion(r.data)).length, cambios };
}
/** Barrido periódico: autocierre y recálculo de requiere_atencion en todas las raíces. */
export async function barrido(store, { now = () => new Date().toISOString() } = {}) {
  const hilos = agrupar(await todos(store, COL)), cerrados = await autocerrar(store, { now, hilos }), corregidos = await recalcularAtencion(store, { hilos });
  return { cerrados, corregidos };
}

async function cerrar(store, raiz, principal, extra, now) {
  const d = { ...raiz.data, estado: 'resuelto', resuelto_por: agenteDe(principal.id), resuelto_por_principal: principal.id, resuelto_en: now(), ...extra };
  d.requiere_atencion = requiereAtencion(d);
  await store.write(COL, raiz.id, d, { updateTime: raiz.updateTime }); return d;
}
export async function resolver(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  escribir(principal); const raiz = await store.get(COL, input.hilo); if (!raiz || raiz.data.es_raiz !== true) fail('board_hilo_no_encontrado', { hilo: input.hilo });
  const yo = agenteDe(principal.id), d = raiz.data;
  if (!(d.agente === yo || d.destinatarios.includes(yo) || esAdminTablon(principal))) fail('forbidden', { ayuda: 'Solo el autor, un destinatario o Alfred pueden resolver un hilo.' });
  if (d.estado === 'resuelto') return { resuelto: false, yaResuelto: true, hilo: raiz.id };
  if (input.nota) await responder(store, { hilo: raiz.id, texto: input.nota }, principal, { now, contar: false });   // resolver no cuenta en el límite de mensajes
  const fresca = await store.get(COL, raiz.id); await cerrar(store, fresca, principal, {}, now);
  return { resuelto: true, hilo: raiz.id, resueltoPor: agenteDe(principal.id) };
}
/** Solo Alfred: registra la decisión en el hilo y lo cierra. */
export async function decidirHilo(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  admin(principal);
  const dec = input.decision;
  if (dec === undefined || dec === null) fail('board_decision_requerida', { campo: 'decision', ayuda: 'Falta «decision»: el texto de la decisión (1 a 2000 caracteres).' });
  if (typeof dec !== 'string') fail('board_decision_invalida', { campo: 'decision', recibido: typeof dec, ayuda: '«decision» debe ser un texto, no un objeto, lista ni número.' });
  if (!dec.trim()) fail('board_decision_requerida', { campo: 'decision', ayuda: '«decision» está vacía: escribe el texto de la decisión (1 a 2000 caracteres).' });
  if (dec.trim().length > 2000) fail('board_decision_invalida', { campo: 'decision', maximo: 2000, longitud: dec.trim().length, ayuda: '«decision» supera los 2000 caracteres: resúmela.' });
  limita(principal);
  const raiz = await store.get(COL, input.hilo); if (!raiz || raiz.data.es_raiz !== true) fail('board_hilo_no_encontrado', { hilo: input.hilo });
  const id = nuevoId(), yo = agenteDe(principal.id), def = [...new Set([raiz.data.agente, ...raiz.data.destinatarios].filter(x => x && x !== yo))];
  await store.write(COL, id, { id, hilo: raiz.id, es_raiz: false, autor: yo, principal: principal.id, agente: yo, tipo: 'decision', asunto: raiz.data.asunto, texto: text(input.decision, 1, 2000, 'board_texto_invalido'), destinatarios: def.length ? def : ['todos'], prioridad: raiz.data.prioridad, estado: 'abierto', referencias: referencias(input.referencias), creado_en: now() }, { create: true });
  if (input.cerrar !== false && raiz.data.estado !== 'resuelto') await cerrar(store, await store.get(COL, raiz.id), principal, { decision_id: id }, now);
  await recalcularSeguro(store, raiz.id);
  return { decidido: true, hilo: raiz.id, decisionId: id, cerrado: input.cerrar !== false };
}

