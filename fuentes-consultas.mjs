// fuentes-consultas.mjs — operaciones de revisión y consultas de lectura sobre `registro_fuentes` (todas puras salvo marcarRevisada).
import { fail, authorize } from './event-domain.mjs';
import { agenteCanonico } from './identidad.mjs';
import { readRegistry, normalizeName } from './registro-fuentes.mjs';
import { ficha, estadoRevision, frecuenciaDe, proximaRevision, zonaDe, urlClave, normalizarUrl, ESTADOS_REVISABLES } from './fuentes-modelo.mjs';

const MAX_LIST = 500;
const vigentes = rows => rows.filter(r => r.data.estado !== 'fusionada');
const norm = v => normalizeName(v);
const coincideZona = (d, z) => { const n = norm(z); return !!n && [d.zona, d.region, d.provincia, d.comarca, d.municipio].some(v => norm(v) === n); };

async function cargar(store, principal) { authorize(principal, null, 'read'); return vigentes(await readRegistry(store)); }
function localizar(rows, { fuenteId, codigo }) {
  const r = fuenteId ? rows.find(x => x.id === fuenteId) : rows.find(x => x.data.codigo === codigo);
  if (!r) fail('fuente_no_encontrada', { fuenteId: fuenteId || null, codigo: codigo || null });
  return r;
}

/** Guarda la revisión de una fuente: fecha, eventos nuevos encontrados y próxima revisión recalculada. El agente sale del token. */
export async function marcarRevisada(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  authorize(principal, null, 'register_source');
  if (!input.fuenteId && !input.codigo) fail('fuente_id_requerido', { ayuda: 'Pasa fuenteId o codigo (F-XXX-0000).' });
  if (!Number.isInteger(input.eventosNuevos) || input.eventosNuevos < 0 || input.eventosNuevos > 10000) fail('fuente_eventos_nuevos_invalido', { ayuda: 'eventosNuevos: entero ≥ 0 (0 si la revisión no encontró nada nuevo).' });
  if (input.fechaUltimoEvento != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.fechaUltimoEvento)) fail('fuente_fecha_invalida', { ayuda: 'fechaUltimoEvento: AAAA-MM-DD.' });
  const resultado = input.resultado ?? 'ok';
  if (!['ok', 'error'].includes(resultado)) fail('fuente_resultado_invalido', { validos: ['ok', 'error'] });
  for (let intento = 0; intento < 2; intento++) {
    const row = input.fuenteId ? await store.get('registro_fuentes', input.fuenteId) : localizar(await readRegistry(store), { codigo: input.codigo });
    if (!row) fail('fuente_no_encontrada', { fuenteId: input.fuenteId });
    const d = structuredClone(row.data);
    if (d.estado === 'fusionada') fail('fuente_fusionada', { fuenteId: row.id, fusionadaEn: d.fusionada_en || null });
    if (['bloqueada', 'descartada'].includes(d.estado)) fail('fuente_no_revisable', { fuenteId: row.id, estado: d.estado, ayuda: 'Una fuente ' + d.estado + ' no se revisa. Si ya se puede usar, cámbiala antes con actualizar_fuente (estado="activa").' });
    const t = now(), freq = frecuenciaDe(d), antes = { ultima_revision: d.ultima_revision ?? null, proxima_revision: d.proxima_revision ?? null, eventos_aportados: d.eventos_aportados ?? 0 };
    d.ultima_revision = t; d.proxima_revision = proximaRevision(t, freq); d.ultimo_resultado = resultado;
    d.fallos_seguidos = resultado === 'error' ? (Number(d.fallos_seguidos) || 0) + 1 : 0;
    d.eventos_aportados = (Number(d.eventos_aportados) || 0) + input.eventosNuevos;
    if (input.eventosNuevos > 0) d.ultimo_evento_encontrado = input.fechaUltimoEvento || t.slice(0, 10);
    else if (input.fechaUltimoEvento) d.ultimo_evento_encontrado = input.fechaUltimoEvento;
    if (input.notas) d.notas = String(input.notas).trim().slice(0, 1000);
    if (d.estado === 'descubierta' && resultado === 'ok') d.estado = 'activa';
    d.modificada_por = agenteCanonico(principal.id); d.modificada_por_principal = principal.id; d.modificada_en = t;
    d.historial = [...(Array.isArray(d.historial) ? d.historial : []), { en: t, por: agenteCanonico(principal.id), principal: principal.id, motivo: 'revisión', cambios: [{ campo: 'revision', antes, despues: { ultima_revision: t, eventosNuevos: input.eventosNuevos, resultado } }] }].slice(-25);
    try { await store.write('registro_fuentes', row.id, d, { updateTime: row.updateTime }); }
    catch (e) { if (e.code === 'version_conflict' && intento === 0) continue; throw e; }
    return { revisada: true, fuenteId: row.id, codigo: d.codigo ?? null, revisadaPor: agenteCanonico(principal.id), ultimaRevision: t, proximaRevision: d.proxima_revision, frecuenciaDias: freq, eventosNuevos: input.eventosNuevos, eventosEncontrados: d.eventos_aportados, ultimoEventoEncontrado: d.ultimo_evento_encontrado ?? null, resultado, estado: d.estado };
  }
  fail('version_conflict');
}

/** Fuentes cuya revisión ha vencido o que nunca se han revisado, de la más antigua a la más reciente. */
export async function listarVencidas(store, input, principal, { ahora = Date.now() } = {}) {
  const rows = await cargar(store, principal);
  const resp = input.responsable === 'yo' ? agenteCanonico(principal.id) : input.responsable ? agenteCanonico(String(input.responsable).toLowerCase()) : null;
  const limite = Math.min(Math.max(input.limite || 50, 1), MAX_LIST), desde = Math.max(input.desde || 0, 0);
  const sel = rows.filter(r => {
    const d = r.data, e = estadoRevision(d, ahora);
    if (!e.vencida) return false;
    if (input.incluirSinRevisar === false && e.sinRevisar) return false;
    if (resp && agenteCanonico(d.responsable) !== resp) return false;
    if (input.zona && !coincideZona(d, input.zona)) return false;
    if (input.provincia && norm(d.provincia) !== norm(input.provincia)) return false;
    return true;
  }).map(r => ({ r, f: ficha(r, ahora) }));
  // Antigüedad: sin revisar primero (por fecha de alta), luego la revisión más antigua.
  sel.sort((a, b) => { const ka = a.f.ultimaRevision ? Date.parse(a.f.ultimaRevision) : -Infinity, kb = b.f.ultimaRevision ? Date.parse(b.f.ultimaRevision) : -Infinity; if (ka !== kb) return ka - kb; const ca = Date.parse(a.f.creadaEn) || 0, cb = Date.parse(b.f.creadaEn) || 0; return ca - cb || (a.r.id < b.r.id ? -1 : 1); });
  const page = sel.slice(desde, desde + limite).map(({ f }) => ({ ...f, diasVencida: f.proximaRevision ? Math.max(0, Math.floor((ahora - Date.parse(f.proximaRevision)) / 86400000)) : null }));
  return { total: sel.length, devueltas: page.length, desde, hayMas: desde + page.length < sel.length, items: page };
}

export async function buscarFichas(store, input, principal) {
  const rows = await cargar(store, principal);
  const q = norm(input.nombre), u = normalizarUrl(input.url), mun = norm(input.municipio);
  const hits = rows.filter(r => {
    const d = r.data;
    if (input.codigo && d.codigo === input.codigo) return true;
    if (u && urlClave(d) === u) return true;
    if (q && norm(d.nombre_entidad).includes(q) && (!mun || norm(d.municipio) === mun)) return true;
    if (!q && !u && !input.codigo && mun && norm(d.municipio) === mun) return true;
    return false;
  }).slice(0, 50).map(r => ficha(r));
  return { total: hits.length, fuentes: hits };
}

// ---- Consultas de agregación (las mismas que usará la vista del dashboard) ----
const cuenta = (rows, fn) => { const m = new Map(); for (const r of rows) { const k = fn(r.data) ?? '(sin dato)'; m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]).map(([clave, total]) => ({ clave, total })); };
export const porZona = rows => cuenta(rows, d => zonaDe(d));
export const porResponsable = rows => cuenta(rows, d => d.responsable ? agenteCanonico(d.responsable) : null);
export const porEstado = rows => cuenta(rows, d => d.estado || 'descubierta');
export const bloqueadas = rows => rows.filter(r => r.data.estado === 'bloqueada').map(r => ({ ...ficha(r) }));
export const vencidasDe = (rows, ahora = Date.now()) => rows.filter(r => estadoRevision(r.data, ahora).vencida);
/** Rendimiento: eventos por fuente, directos (fuenteId del evento) e inferidos (misma página/dominio que la URL de la fuente). */
export function rendimiento(rows, eventos) {
  const porId = new Map(), claves = [];
  for (const r of rows) { porId.set(r.id, r); if (r.data.codigo) porId.set(r.data.codigo, r); const k = urlClave(r.data); if (k && r.data.canal === 'web') claves.push([k.split('?')[0], r]); }
  const directos = new Map(), inferidos = new Map(); let sinFuente = 0, fuenteDesconocida = 0;
  for (const e of eventos) {
    const d = e.data || e; if (d.prueba === true || d.retirado === true) continue;
    if (d.fuenteId) { const r = porId.get(d.fuenteId); if (r) directos.set(r.id, (directos.get(r.id) || 0) + 1); else fuenteDesconocida++; continue; }
    const k = normalizarUrl(d.fuentes?.[0]?.url || d.link), hit = k && claves.filter(([ck]) => k === ck || k.startsWith(ck + '/')).sort((a, b) => b[0].length - a[0].length)[0];
    if (hit) inferidos.set(hit[1].id, (inferidos.get(hit[1].id) || 0) + 1); else sinFuente++;
  }
  const items = rows.map(r => ({ fuenteId: r.id, codigo: r.data.codigo ?? null, nombre: r.data.nombre_entidad ?? null, responsable: r.data.responsable ? agenteCanonico(r.data.responsable) : null, estado: r.data.estado ?? null, eventosDirectos: directos.get(r.id) || 0, eventosInferidos: inferidos.get(r.id) || 0, eventosEncontradosRevisiones: Number(r.data.eventos_aportados) || 0 }));
  items.forEach(i => { i.eventos = i.eventosDirectos + i.eventosInferidos; });
  return { items: items.sort((a, b) => b.eventos - a.eventos), eventosSinFuenteIdentificada: sinFuente, eventosConFuenteIdDesconocida: fuenteDesconocida };
}

export async function resumenFuentes(store, input, principal, { ahora = Date.now(), eventos = null } = {}) {
  const rows = await cargar(store, principal), v = vencidasDe(rows, ahora), top = Math.min(Math.max(input.top || 15, 1), 100);
  const out = {
    total: rows.length, porEstado: porEstado(rows), porZona: porZona(rows).slice(0, top), porResponsable: porResponsable(rows),
    vencidas: { total: v.length, porResponsable: porResponsable(v), porZona: porZona(v).slice(0, top) },
    sinRevisar: rows.filter(r => estadoRevision(r.data, ahora).sinRevisar).length,
    sinZona: rows.filter(r => !zonaDe(r.data)).length, sinUrl: rows.filter(r => !r.data.url && !r.data.url_normalizada).length,
    bloqueadas: bloqueadas(rows).slice(0, top).map(f => ({ fuenteId: f.fuenteId, codigo: f.codigo, nombre: f.nombre, motivo: f.motivoBloqueo })),
    generado: new Date(ahora).toISOString()
  };
  if (input.conRendimiento && eventos) { const rd = rendimiento(rows, eventos); out.rendimiento = { top: rd.items.slice(0, top), activasSinEventos: rd.items.filter(i => i.eventos === 0 && ['activa', 'descubierta', null].includes(i.estado)).length, eventosSinFuenteIdentificada: rd.eventosSinFuenteIdentificada, eventosConFuenteIdDesconocida: rd.eventosConFuenteIdDesconocida }; }
  return out;
}
