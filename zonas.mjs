// zonas.mjs — reparto de zonas entre agentes (colección `zonas_agentes`) con jerarquía: municipio > comarca > zona > provincia > comunidad.
// La asignación MÁS ESPECÍFICA prevalece (Salamanca dentro de Castilla y León, Málaga dentro de Andalucía). Solo Alfred (board_admin) asigna y reparte.
import { fail, authorize, hash } from './event-domain.mjs';
import { readRegistry, normalizeName } from './registro-fuentes.mjs';
import { reconocerZona, regionDeProvincia } from './territorio.mjs';
import { agenteCanonico } from './identidad.mjs';
import { publicar, resolver, adminTablon, esAdminTablon, agenteDe } from './tablon.mjs';

export const ZON = 'zonas_agentes';
const AGENTE_RE = /^[a-z0-9_-]{2,40}$/;
const NIVELES = ['municipio', 'comarca', 'zona', 'provincia', 'region'];
const puede = (p, a) => { try { authorize(p, null, a); return true; } catch { return false; } };
const leer = p => { if (!puede(p, 'board') && !puede(p, 'board_read')) authorize(p, null, 'board'); };
const text = (v, min, max, code) => { if (typeof v !== 'string') fail(code); const s = v.trim(); if (s.length < min || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) fail(code, { minimo: min, maximo: max }); return s; };

/** Nombre canónico de una zona: provincias y comunidades se normalizan («Comunidad de Madrid» → Madrid, «Islas Baleares» → Illes Balears). */
export function nombreZona(z) { const k = reconocerZona(z); if (k?.tipo === 'provincia') return k.provincia; if (k?.tipo === 'region') return k.region; return String(z).trim().replace(/\s+/g, ' '); }
export const claveZona = z => normalizeName(nombreZona(z)).replace(/\s+/g, '-');
export const tipoZona = z => { const k = reconocerZona(z); return k ? (k.tipo === 'provincia' ? 'provincia' : 'region') : 'local'; };

/** Localización normalizada de una fuente o evento: municipio, comarca, zona propia, provincia y comunidad canónicas. */
export function ubicacionDe(d) {
  let municipio = d.municipio || d.city || null, ambitoRegion = null;
  const amb = /^\s*[aá]mbito regional\s+(.+)$/i.exec(municipio || '');   // «Ámbito regional Castilla-La Mancha»: no es un municipio
  if (amb) { const z = reconocerZona(amb[1]); ambitoRegion = z?.tipo === 'region' ? z.region : (z?.tipo === 'provincia' ? z.region : null); municipio = null; }
  if (municipio && /^\s*(?:[aá]mbito editorial por contrastar|por determinar|\(provincial\))/i.test(municipio)) municipio = null;
  const prov0 = reconocerZona(d.provincia || d.geoUbicacion?.provincia), reg0 = reconocerZona(d.region);
  let provincia = prov0?.tipo === 'provincia' ? prov0.provincia : null, region = reg0?.tipo === 'region' ? reg0.region : (reg0?.tipo === 'provincia' ? reg0.region : null);
  if (!region && prov0?.tipo === 'region') region = prov0.region;           // «Galicia» escrito en provincia
  if (!region && provincia) region = regionDeProvincia(provincia);
  if (!provincia && reg0?.tipo === 'provincia') provincia = reg0.provincia;
  if (!region) region = ambitoRegion;
  return { municipio, comarca: d.comarca || null, zona: d.zona || null, provincia, region };
}
/** Provincia más frecuente de cada municipio según las fuentes que ya la tienen: sirve para ubicar las que solo traen el municipio. */
export function provinciasPorMunicipio(rows) {
  const cuenta = new Map();
  for (const r of rows) { const u = ubicacionDe(r.data || r); if (!u.municipio || !u.provincia) continue; const k = normalizeName(u.municipio), m = cuenta.get(k) || new Map(); m.set(u.provincia, (m.get(u.provincia) || 0) + 1); cuenta.set(k, m); }
  return new Map([...cuenta].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
}
function completarUbicacion(loc, provDe) {
  if (loc.provincia || loc.region || !loc.municipio) return loc;
  const p = provDe.get(normalizeName(loc.municipio)); return p ? { ...loc, provincia: p, region: regionDeProvincia(p), deducida: true } : loc;
}
/** Resuelve el agente responsable de una ubicación con la asignación más específica. asignaciones: [{clave, zona, agente}] */
export function resolverAgente(asignaciones, loc) {
  const porClave = new Map(asignaciones.map(a => [a.clave, a]));
  for (const nivel of NIVELES) { if (!loc[nivel]) continue; const k = claveZona(loc[nivel]), a = porClave.get(k); if (a) return { agente: a.agente, zona: a.zona, nivel }; }
  return null;
}
async function cargarAsignaciones(store) {
  const rows = []; let cursor = null; for (;;) { const page = await store.list(ZON, { cursor, limit: 500 }); if (!Array.isArray(page)) fail('incomplete_scan'); rows.push(...page); if (page.length < 500) break; cursor = page.at(-1).id; }
  return rows.map(r => ({ clave: r.id, zona: r.data.zona, tipo: r.data.tipo || tipoZona(r.data.zona), agente: agenteCanonico(r.data.agente), asignadaPor: r.data.asignada_por, desde: r.data.desde, motivo: r.data.motivo ?? null, cambios: (r.data.historial || []).length, _row: r }));
}

export async function listarZonas(store, input, principal) {
  leer(principal); const as = await cargarAsignaciones(store);
  const zonas = as.map(({ _row, ...z }) => z).sort((a, b) => a.zona.localeCompare(b.zona, 'es')), porAgente = {};
  for (const z of zonas) (porAgente[z.agente] ||= []).push(z.zona);
  const out = { total: zonas.length, zonas, porAgente };
  const c = input?.consultar;
  if (c) { const loc = ubicacionDe({ municipio: c.municipio, comarca: c.comarca, provincia: c.provincia, region: c.ccaa || c.region, zona: c.zona }), r = resolverAgente(as, loc); out.consulta = { ubicacion: loc, resuelve: r }; }
  return out;
}

async function escribirAsignacion(store, zona, agente, motivo, principal, now) {
  const nombre = nombreZona(zona), clave = claveZona(zona), prev = await store.get(ZON, clave), t = now();
  if (prev && agenteCanonico(prev.data.agente) === agente) return { cambio: false, zona: prev.data.zona, agente };
  const yo = agenteDe(principal.id);
  const d = { id: clave, zona: prev?.data.zona || nombre, tipo: tipoZona(nombre), agente, asignada_por: yo, asignada_por_principal: principal.id, desde: t, motivo, historial: [...(prev?.data.historial || []), ...(prev ? [{ agente: agenteCanonico(prev.data.agente), desde: prev.data.desde, hasta: t, cambiadaPor: yo, motivo }] : [])].slice(-50) };
  await store.write(ZON, clave, d, prev ? { updateTime: prev.updateTime } : { create: true });
  return { cambio: true, zona: d.zona, agente, anterior: prev ? agenteCanonico(prev.data.agente) : null };
}
export async function asignarZona(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  adminTablon(principal); const zona = text(input.zona, 2, 120, 'board_zona_invalida'), agente = agenteCanonico(String(input.agente || '').toLowerCase().trim()); if (!AGENTE_RE.test(agente)) fail('board_destinatarios_invalidos');
  const motivo = text(input.motivo, 5, 500, 'board_texto_invalido'), r = await escribirAsignacion(store, zona, agente, motivo, principal, now);
  if (!r.cambio) return { asignada: false, yaAsignada: true, zona: r.zona, agente };
  const msg = await publicar(store, { tipo: 'asignacion', asunto: `Zona ${r.zona} → ${agente}`.slice(0, 120), texto: `Alfred asigna la zona «${r.zona}» a ${agente}${r.anterior ? ` (antes: ${r.anterior})` : ''}. Motivo: ${motivo}`, destinatarios: ['todos', agente], referencias: { zona: r.zona } }, principal, { now });
  await resolver(store, { hilo: msg.hilo }, principal, { now });
  return { asignada: true, zona: r.zona, agente, anterior: r.anterior, mensajeId: msg.id };
}
/** Carga un reparto completo de una vez. modo=simular (por defecto) no escribe. Un solo aviso en el tablón. */
export async function asignarZonasLote(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  adminTablon(principal); const motivo = text(input.motivo, 5, 500, 'board_texto_invalido');
  if (!Array.isArray(input.reparto) || !input.reparto.length || input.reparto.length > 100) fail('board_reparto_invalido', { ayuda: 'reparto: lista de 1 a 100 {zona, agente}.' });
  const items = input.reparto.map(x => ({ zona: nombreZona(text(String(x.zona ?? ''), 2, 120, 'board_zona_invalida')), agente: agenteCanonico(String(x.agente || '').toLowerCase().trim()) })); if (items.some(i => !AGENTE_RE.test(i.agente))) fail('board_destinatarios_invalidos');
  const claves = items.map(i => claveZona(i.zona)); if (new Set(claves).size !== claves.length) fail('board_reparto_invalido', { ayuda: 'Hay zonas repetidas en el reparto.' });
  const actual = new Map((await cargarAsignaciones(store)).map(a => [a.clave, a])), cambios = items.map(i => ({ ...i, tipo: tipoZona(i.zona), anterior: actual.get(claveZona(i.zona))?.agente ?? null })).map(c => ({ ...c, accion: c.anterior === c.agente ? 'sin_cambio' : (c.anterior ? 'cambia' : 'nueva') }));
  if ((input.modo || 'simular') !== 'aplicar') return { modo: 'simular', zonas: cambios.length, nuevas: cambios.filter(c => c.accion === 'nueva').length, cambian: cambios.filter(c => c.accion === 'cambia').length, sinCambio: cambios.filter(c => c.accion === 'sin_cambio').length, reparto: cambios, nota: 'No se ha escrito nada. Repite con modo="aplicar".' };
  const hechas = []; for (const c of cambios) { if (c.accion === 'sin_cambio') continue; await escribirAsignacion(store, c.zona, c.agente, motivo, principal, now); hechas.push(c); }
  let mensajeId = null;
  if (hechas.length) { const msg = await publicar(store, { tipo: 'asignacion', asunto: `Reparto de zonas (${hechas.length} zonas)`, texto: hechas.map(c => `${c.zona} → ${c.agente}`).join('; ').slice(0, 1900), destinatarios: ['todos'] }, principal, { now }); await resolver(store, { hilo: msg.hilo }, principal, { now }); mensajeId = msg.id; }
  return { modo: 'aplicar', asignadas: hechas.length, sinCambio: cambios.length - hechas.length, mensajeId };
}

const coincideFuente = (d, as) => resolverAgente(as, ubicacionDe(d));
/** Solo Alfred. Cambia `responsable` de las fuentes de una zona respetando la jerarquía: las que pertenecen a una zona más específica con otro agente no se tocan. */
export async function reasignarFuentesZona(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  adminTablon(principal); const zona = text(input.zona, 2, 120, 'board_zona_invalida'), agente = agenteCanonico(String(input.agente || '').toLowerCase().trim()); if (!AGENTE_RE.test(agente)) fail('board_destinatarios_invalidos');
  const clave = claveZona(zona), as = (await cargarAsignaciones(store)).filter(a => a.clave !== clave).concat([{ clave, zona: nombreZona(zona), agente }]);
  const rows = (await readRegistry(store)).filter(r => r.data.estado !== 'fusionada' && coincideFuente(r.data, as)?.zona && claveZona(coincideFuente(r.data, as).zona) === clave && agenteCanonico(r.data.responsable) !== agente).sort((a, b) => (a.id < b.id ? -1 : 1));
  const codigo = hash(JSON.stringify([zona, agente, rows.map(r => r.id)])).slice(0, 12), actuales = {}; for (const r of rows) { const k = r.data.responsable ? agenteCanonico(r.data.responsable) : '(sin responsable)'; actuales[k] = (actuales[k] || 0) + 1; }
  if ((input.modo || 'simular') !== 'aplicar') return { modo: 'simular', zona: nombreZona(zona), agente, fuentesQueCambian: rows.length, responsableActual: actuales, muestra: rows.slice(0, 15).map(r => ({ fuenteId: r.id, nombre: r.data.nombre_entidad ?? null, responsableActual: r.data.responsable ?? null })), codigoConfirmacion: codigo, nota: 'No se ha escrito nada. Las fuentes de una zona más específica con otro agente no se incluyen. Para aplicar repite con modo="aplicar" y este codigoConfirmacion.' };
  if (input.codigoConfirmacion !== codigo) fail('board_confirmacion_invalida', { ayuda: 'El código no corresponde al estado actual de la zona: repite la simulación.' });
  return aplicarCambios(store, rows.map(r => ({ row: r, agente })), principal, input.motivo || `Reparto de zona ${nombreZona(zona)}`, input.limite, now, rows.length);
}
async function aplicarCambios(store, cambios, principal, motivoIn, limite, now, total) {
  const motivo = text(motivoIn, 5, 500, 'board_texto_invalido'), lim = Math.min(Math.max(limite || 500, 1), 500), yo = agenteDe(principal.id); let hechas = 0, conflictos = 0;
  for (const { row: r, agente } of cambios.slice(0, lim)) {
    const t = now(), d = { ...r.data, responsable: agente, modificada_por: yo, modificada_por_principal: principal.id, modificada_en: t, historial: [...(r.data.historial || []), { en: t, por: yo, principal: principal.id, motivo, cambios: [{ campo: 'responsable', antes: r.data.responsable ?? null, despues: agente }] }].slice(-25) };
    try { await store.write('registro_fuentes', r.id, d, { updateTime: r.updateTime }); hechas++; } catch (e) { if (e.code === 'version_conflict') conflictos++; else throw e; }
  }
  return { modo: 'aplicar', reasignadas: hechas, conflictos, restantes: Math.max(total - lim, 0) + conflictos, nota: 'Si quedan restantes, vuelve a simular y aplicar.' };
}

/** Solo Alfred. Asigna responsable a las fuentes que no tienen (o a todas, alcance="todas") según su provincia o comunidad y el reparto de zonas cargado. Las que no se pueden resolver salen en un listado aparte para revisar a mano. */
export async function repartirFuentes(store, input, principal, { now = () => new Date().toISOString() } = {}) {
  adminTablon(principal); const as = await cargarAsignaciones(store); if (!as.length) fail('board_sin_zonas', { ayuda: 'Primero carga el reparto de zonas con asignar_zona o asignar_zonas_lote.' });
  const alcance = input.alcance === 'todas' ? 'todas' : 'sin_responsable', rows = (await readRegistry(store)).filter(r => r.data.estado !== 'fusionada').sort((a, b) => (a.id < b.id ? -1 : 1));
  const plan = [], sinZona = [], porAgente = {}, porZona = {}, provDe = provinciasPorMunicipio(rows); let candidatas = 0, deducidas = 0;
  for (const r of rows) {
    const actual = r.data.responsable ? agenteCanonico(r.data.responsable) : null; if (alcance === 'sin_responsable' && actual) continue; candidatas++;
    const loc = completarUbicacion(ubicacionDe(r.data), provDe), res = resolverAgente(as, loc); if (res && loc.deducida) deducidas++;
    if (!res) { sinZona.push({ fuenteId: r.id, codigo: r.data.codigo ?? null, nombre: r.data.nombre_entidad ?? null, municipio: loc.municipio, provincia: loc.provincia, ccaa: loc.region, motivo: !loc.municipio && !loc.provincia && !loc.region && !loc.comarca && !loc.zona ? 'sin_ubicacion' : 'zona_sin_agente' }); continue; }
    if (res.agente === actual) continue; plan.push({ row: r, agente: res.agente }); porAgente[res.agente] = (porAgente[res.agente] || 0) + 1; porZona[res.zona] = (porZona[res.zona] || 0) + 1;
  }
  const codigo = hash(JSON.stringify([alcance, plan.map(p => [p.row.id, p.agente]), sinZona.map(s => s.fuenteId)])).slice(0, 12);
  if ((input.modo || 'simular') !== 'aplicar') return { modo: 'simular', alcance, candidatas, fuentesQueCambian: plan.length, ubicadasPorSuMunicipio: deducidas, porAgente, porZona, sinZona: { total: sinZona.length, motivos: sinZona.reduce((m, s) => (m[s.motivo] = (m[s.motivo] || 0) + 1, m), {}), listado: sinZona.slice(0, 300) }, codigoConfirmacion: codigo, nota: 'No se ha escrito nada. Las fuentes de «sinZona» no se tocan: revísalas a mano. Para aplicar repite con modo="aplicar" y este codigoConfirmacion.' };
  if (input.codigoConfirmacion !== codigo) fail('board_confirmacion_invalida', { ayuda: 'El código no corresponde al estado actual: repite la simulación.' });
  return { ...(await aplicarCambios(store, plan, principal, input.motivo || 'Reparto de fuentes sin responsable por zona', input.limite, now, plan.length)), sinZona: sinZona.length };
}
export { esAdminTablon };
