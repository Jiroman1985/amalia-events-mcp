// migracion-fuentes.mjs — planificación PURA de la migración Sheet «Fuentes actuales amalia» + registro del MCP -> repositorio único.
// No lee ni escribe nada: recibe las filas y devuelve el plan y el informe. El script migrar_fuentes.mjs lo usa en modo ensayo (por defecto) o aplicar.
import { hash } from './event-domain.mjs';
import { normalizeName, canonicalSource, sourceId } from './registro-fuentes.mjs';
import { normalizarUrl, esEnlaceSinResolver, urlClave, TIPOS, ESTADOS } from './fuentes-modelo.mjs';
import { reconocerZona } from './territorio.mjs';

const ALIAS = {
  codigo: ['id', 'codigo', 'id fuente', 'cod', 'id_fuente'], nombre: ['nombre', 'nombre negocio entidad', 'nombre negocio/entidad', 'nombre fuente', 'fuente', 'entidad', 'nombre entidad', 'nombre_entidad', 'organismo'],
  tipo: ['tipo', 'tipo fuente'], ambito: ['ambito', 'ámbito'], ccaa: ['ccaa', 'comunidad autonoma', 'comunidad', 'region'], provincia: ['provincia'], comarca: ['comarca'],
  municipio: ['municipio', 'localidad', 'ciudad'], zona: ['zona'], url: ['url', 'url principal', 'web', 'enlace', 'link', 'url fuente', 'pagina web', 'sitio web'],
  instagram: ['instagram', 'ig'], facebook: ['facebook', 'fb'], x: ['x', 'twitter', 'x twitter'], tiktok: ['tiktok'], email: ['email', 'correo', 'mail', 'e mail', 'correo electronico'],
  telefono: ['telefono', 'tel', 'teléfono'], frecuencia: ['frecuencia', 'frecuencia dias', 'frecuencia revision', 'frecuencia de revision', 'frecuencia revision dias'],
  ultima_revision: ['ultima revision', 'fecha ultima revision', 'ultima_revision', 'revisada', 'ultima revisión'], responsable: ['responsable', 'agente', 'asignado', 'asignada', 'asignado a'],
  estado: ['estado'], eventos: ['eventos encontrados', 'eventos', 'eventos aportados'], patron: ['patron de publicacion', 'patrón de publicación'], canal: ['canal'], notas: ['notas', 'observaciones', 'comentarios', 'nota'], origen: ['origen']
};
export function mapearCabeceras(cabeceras, mapaManual = {}) {
  const mapa = {}, usadas = new Set();
  cabeceras.forEach((h, i) => {
    const n = normalizeName(h); if (!n) return;
    const manual = Object.entries(mapaManual).find(([, col]) => normalizeName(col) === n)?.[0];
    const campo = manual || Object.entries(ALIAS).find(([, al]) => al.some(a => normalizeName(a) === n))?.[0];
    if (campo && !(campo in mapa)) { mapa[campo] = i; usadas.add(i); }
  });
  return { mapa, sinMapear: cabeceras.map((h, i) => [h, i]).filter(([h, i]) => !usadas.has(i) && String(h || '').trim()).map(([h]) => h) };
}
const estadoDeHoja = crudo => { const n = normalizeName(crudo); if (!n) return null; if (/^descartad/.test(n)) return 'descartada'; if (/restring|bloquead/.test(n)) return 'bloqueada'; if (/^pausad/.test(n)) return 'pausada'; if (/nueva|sin revisar|descubiert/.test(n)) return 'descubierta'; return 'activa'; };
const tipoDeHoja = crudo => { const n = normalizeName(crudo); if (!n) return null; if (/agenda/.test(n)) return 'agenda'; if (/ayuntamiento|institucion|web municipal|diputacion/.test(n)) return 'ayuntamiento'; if (/restauraci/.test(n)) return 'restauracion'; if (/teatro/.test(n)) return 'teatro'; if (/museo|espacio/.test(n)) return 'museo'; if (/asociaci|ong|comunidad/.test(n)) return 'asociacion'; if (/organizador/.test(n)) return 'organizador'; if (/medio|creador|influencer/.test(n)) return 'medio'; if (/particular/.test(n)) return 'particular'; if (/negocio|oferta/.test(n)) return 'negocio'; if (/turismo/.test(n)) return 'turismo'; if (/plataforma/.test(n)) return 'plataforma'; if (/redes|perfil/.test(n)) return 'redes'; return 'otro'; };
const diasDeHoja = crudo => { const n = normalizeName(crudo); if (!n) return null; const m = n.match(/(\d+)/); if (m) { const d = parseInt(m[1], 10); return d >= 1 && d <= 365 ? d : null; } if (/diari/.test(n)) return 1; if (/semanal/.test(n)) return 7; if (/quincenal/.test(n)) return 15; if (/mensual/.test(n)) return 30; if (/trimestral/.test(n)) return 90; if (/anual/.test(n)) return 365; return null; };
const responsableDeHoja = crudo => { const n = String(crudo || '').replace(/\(.*?\)/g, '').normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase().split(/\s+/)[0]; return /^[a-z0-9_-]{2,40}$/.test(n) ? n : null; };
const ESTADO_MAP = { activa: 'activa', activo: 'activa', pausada: 'pausada', pausado: 'pausada', bloqueada: 'bloqueada', bloqueado: 'bloqueada', descartada: 'descartada', descartado: 'descartada', descubierta: 'descubierta' };
const fechaIso = v => { const s = String(v || '').trim(); if (!s) return null; let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`; m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T00:00:00.000Z`; return null; };
const CODIGO_RE = /F-[A-Z0-9]{2,6}-\d{3,5}/g;

export function filaDeHoja(valores, mapa, numero) {
  const g = k => (k in mapa ? String(valores[mapa[k]] ?? '').trim() : '');
  const urlCruda = g('url'), freq = diasDeHoja(g('frecuencia')), estadoCrudo = normalizeName(g('estado'));
  let ccaa = g('ccaa'), prov = g('provincia'); const zProv = reconocerZona(prov); if (zProv?.tipo === 'region') { ccaa = ccaa || zProv.region; prov = ''; } // «Galicia» en la columna Provincia es un error de alta: es la CCAA
  return {
    fila: numero, codigo: g('codigo') || null, nombre: g('nombre') || null, tipo: tipoDeHoja(g('tipo')), tipoOriginal: g('tipo') || null, ambito: g('ambito') || null, ccaa: ccaa || null,
    provincia: zProv?.tipo === 'provincia' ? zProv.provincia : (prov || null), comarca: g('comarca') || null, municipio: g('municipio') || null, zona: g('zona') || null,
    urlCruda: urlCruda || null, urlClave: normalizarUrl(urlCruda), sinResolver: !!urlCruda && esEnlaceSinResolver(urlCruda),
    redes: Object.fromEntries(['instagram', 'facebook', 'x', 'tiktok'].map(k => [k, g(k)]).filter(([, v]) => v)), email: g('email') || null, telefono: g('telefono') || null,
    frecuenciaDias: freq, ultimaRevision: fechaIso(g('ultima_revision')), responsable: responsableDeHoja(g('responsable')),
    idsMcp: [...new Set(String(g('notas')).match(/fte_(?:web|instagram|tiktok|correo|hoja)_[0-9a-f]{24}/g) || [])], aliasDe: (g('notas').match(/fusionad\w*(?:\s+documentalmente)?\s+en\s+(F-[A-Z0-9]{2,6}-\d{3,5})/i) || [])[1] || null, estado: estadoDeHoja(g('estado')), estadoCrudo: g('estado') || null, notas: g('notas') || null, origen: g('origen') || null, eventos: parseInt(g('eventos'), 10) >= 0 ? parseInt(g('eventos'), 10) : 0, patron: g('patron') || null, canalHoja: g('canal') || null
  };
}
const STOP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'ayto', 'ayuntamiento', 'concello', 'agenda', 'web', 'oficial']);
const compacto = v => normalizeName(v).split(' ').filter(t => t && !STOP.has(t)).join('');
// Nombres de la misma entidad aunque difieran en artículos, espacios o prefijos genéricos («Museo Jorge Rando» ~ «Agenda museojorgerando.org»).
const similar = (a, b) => { const x = normalizeName(a), y = normalizeName(b); if (!x || !y) return false; if (x === y || (Math.min(x.length, y.length) >= 8 && (x.includes(y) || y.includes(x)))) return true; const cx = compacto(a), cy = compacto(b); return Math.min(cx.length, cy.length) >= 7 && (cx.includes(cy) || cy.includes(cx)); };
const hostDe = k => String(k || '').split('/')[0].split('?')[0];
const codigosDe = d => [...new Set([d.codigo, ...String(`${d.via || ''} ${d.nombre_entidad || ''} ${d.notas || ''}`).match(CODIGO_RE) || []].filter(Boolean))];

/** Plan + informe. filas: filaDeHoja[]; registro: [{id,data}]. */
export function planificar({ filas, registro, cabeceras = null }) {
  const porClave = new Map(), porCodigoReg = new Map(), porId = new Map(registro.map(r => [r.id, r]));
  for (const r of registro) { const k = urlClave(r.data); if (k) (porClave.get(k) || porClave.set(k, []).get(k)).push(r); for (const c of codigosDe(r.data)) (porCodigoReg.get(c) || porCodigoReg.set(c, []).get(c)).push(r); }
  const informe = { filasHoja: filas.length, registroMcp: registro.length, cabeceras, importar: [], fusionarConRegistro: [], fusionarEntreFilasHoja: [], aliasDocumentales: [], ambiguos: [], pendientesRevision: [], codigosReasignados: [], conflictos: [], nombresDistintos: [], cambiosDeEstado: {}, emparejadasPor: { id_mcp_en_notas: 0, codigo: 0, url: 0 }, sinUrl: [], enlacesSinResolver: [], sinCodigo: [], codigosDuplicadosEnHoja: [], registroSinUrl: [], registroDuplicadoPorUrl: [] };
  // Códigos repetidos en la hoja: la segunda fila recibe el siguiente número libre del prefijo de su provincia (el original se conserva en notas).
  const maxPorPrefijo = new Map(), prefijosProv = new Map(), vistos = new Map();
  for (const f of filas) { const m = (f.codigo || '').match(/^F-([A-Z0-9]+)-(\d+)$/); if (m) { maxPorPrefijo.set(m[1], Math.max(maxPorPrefijo.get(m[1]) || 0, +m[2])); const k = normalizeName(f.provincia); if (k) { const pm = prefijosProv.get(k) || new Map(); pm.set(m[1], (pm.get(m[1]) || 0) + 1); prefijosProv.set(k, pm); } } }
  for (const f of filas) {
    if (!f.codigo) { informe.sinCodigo.push({ fila: f.fila, nombre: f.nombre }); continue; }
    if (!vistos.has(f.codigo)) { vistos.set(f.codigo, f.fila); continue; }
    informe.codigosDuplicadosEnHoja.push({ codigo: f.codigo, filas: [vistos.get(f.codigo), f.fila], nombre: f.nombre, provincia: f.provincia });
    const pm = prefijosProv.get(normalizeName(f.provincia)), prefijo = pm ? [...pm].sort((a, b) => b[1] - a[1])[0][0] : (f.codigo.match(/^F-([A-Z0-9]+)-/) || [])[1];
    if (prefijo && pm) { const n = (maxPorPrefijo.get(prefijo) || 0) + 1; maxPorPrefijo.set(prefijo, n); const nuevo = `F-${prefijo}-${String(n).padStart(4, '0')}`; informe.codigosReasignados.push({ fila: f.fila, antes: f.codigo, despues: nuevo, nombre: f.nombre, provincia: f.provincia }); f.codigoOriginal = f.codigo; f.codigo = nuevo; vistos.set(nuevo, f.fila); }
  }
  for (const f of filas) {
    if (f.sinResolver) informe.enlacesSinResolver.push({ fila: f.fila, codigo: f.codigo, nombre: f.nombre, url: f.urlCruda });
    if (!f.urlClave && !f.sinResolver) informe.sinUrl.push({ fila: f.fila, codigo: f.codigo, nombre: f.nombre, urlCruda: f.urlCruda });
  }
  // 1) Emparejar cada fila con su fuente del registro: por el ID del MCP que lleva en Notas (la hoja a veces sobrescribe la URL de los alias), 2) por código, 3) por URL.
  // Una fila canónica suele citar en Notas el ID del alias que absorbió: ese ID pertenece a la fila alias, no a la canónica.
  const idsDeAlias = new Set(filas.filter(x => x.aliasDe).flatMap(x => x.idsMcp));
  const destinoDe = f => {
    const existentes = f.idsMcp.filter(id => porId.has(id) && (f.aliasDe || !idsDeAlias.has(id)));
    // Un emparejamiento por ID es fiable si coincide la URL, el nombre o el municipio; si no, queda en espera de revisión (no se funde ni se crea).
    const fiable = id => { const d = porId.get(id).data; return (f.urlClave && urlClave(d) === f.urlClave) || similar(f.nombre, d.nombre_entidad) || (normalizeName(f.municipio) && normalizeName(f.municipio) === normalizeName(d.municipio)) || (f.urlClave && urlClave(d) && hostDe(f.urlClave) === hostDe(urlClave(d))); };
    const elegir = ids => { if (ids.length === 1) return ids[0]; const mejores = ids.filter(id => (f.urlClave && urlClave(porId.get(id).data) === f.urlClave) || similar(f.nombre, porId.get(id).data.nombre_entidad)); return mejores.length === 1 ? mejores[0] : null; };
    if (existentes.length) {
      const id = elegir(existentes);
      if (id) { if (fiable(id)) return { reg: [porId.get(id)], por: 'id_mcp_en_notas' }; informe.conflictos.push({ tipo: 'emparejamiento_dudoso', codigo: f.codigo, nombreHoja: f.nombre, urlHoja: f.urlClave, municipioHoja: f.municipio, fuenteId: id, nombreRegistro: porId.get(id).data.nombre_entidad, urlRegistro: urlClave(porId.get(id).data), municipioRegistro: porId.get(id).data.municipio, ayuda: 'La hoja cita este ID del MCP pero URL, nombre y municipio no coinciden: no se migra hasta decidir.' }); return { reg: [], por: null, dudoso: true }; }
      informe.ambiguos.push({ codigo: f.codigo, nombre: f.nombre, fuenteIds: existentes, ayuda: 'Cita varios IDs del MCP sin uno que encaje: se trata como fuente aparte.' });
    }
    const porCod = f.codigo ? porCodigoReg.get(f.codigo) : null; if (porCod?.length) return { reg: porCod, por: 'codigo' };
    const porUrl = f.urlClave ? porClave.get(f.urlClave) : null; if (porUrl?.length) return { reg: porUrl, por: 'url' };
    return { reg: [], por: null };
  };
  const plan = [], sinRegistro = [];
  for (const f of filas) { const d = destinoDe(f); if (d.dudoso) { informe.pendientesRevision.push({ fila: f.fila, codigo: f.codigo, nombre: f.nombre }); continue; } if (d.reg.length) { informe.emparejadasPor[d.por]++; plan.push({ accion: 'fusionar', fuenteId: d.reg[0].id, por: d.por, filas: [f], reg: d.reg }); } else sinRegistro.push(f); }
  // Filas sin fuente en el registro: las que comparten URL entre sí forman una sola fuente nueva.
  const grupos = new Map(); for (const f of sinRegistro) if (f.urlClave) (grupos.get(f.urlClave) || grupos.set(f.urlClave, []).get(f.urlClave)).push(f);
  const hechas = new Set();
  for (const f of sinRegistro) {
    if (hechas.has(f)) continue; const grupo = f.urlClave ? grupos.get(f.urlClave) : [f]; grupo.forEach(x => hechas.add(x));
    if (grupo.length > 1) { informe.fusionarEntreFilasHoja.push({ urlClave: f.urlClave, filas: grupo.map(x => ({ fila: x.fila, codigo: x.codigo, nombre: x.nombre })) }); const cods = [...new Set(grupo.map(x => x.codigo).filter(Boolean))]; if (cods.length > 1) informe.conflictos.push({ tipo: 'codigos_distintos_misma_url_en_hoja', urlClave: f.urlClave, codigos: cods, nombres: [...new Set(grupo.map(x => x.nombre))] }); }
    informe.importar.push({ fila: f.fila, codigo: f.codigo, nombre: f.nombre, urlClave: f.urlClave }); plan.push({ accion: 'crear', filas: grupo });
  }
  // Varias filas de la hoja sobre la misma fuente del registro: se unen en una sola operación.
  const porDestino = new Map(); for (const p of plan.filter(p => p.accion === 'fusionar')) (porDestino.get(p.fuenteId) || porDestino.set(p.fuenteId, []).get(p.fuenteId)).push(p);
  const planFinal = plan.filter(p => p.accion === 'crear');
  for (const [id, ps] of porDestino) {
    const filasDest = ps.flatMap(p => p.filas), d = porId.get(id).data, cods = codigosDe(d);
    const principal = filasDest.find(f => !f.aliasDe) || filasDest[0], alias = filasDest.filter(f => f.aliasDe && f !== principal);
    if (filasDest.length > 1) informe.fusionarEntreFilasHoja.push({ fuenteId: id, filas: filasDest.map(x => ({ fila: x.fila, codigo: x.codigo, nombre: x.nombre })) });
    for (const g of filasDest) {
      informe.fusionarConRegistro.push({ fuenteId: id, por: ps[0].por, codigoHoja: g.codigo, codigoRegistro: d.codigo ?? null, urlClave: g.urlClave, nombreHoja: g.nombre, nombreRegistro: d.nombre_entidad ?? null });
      if (g.codigo && cods.length && !cods.includes(g.codigo)) informe.conflictos.push({ tipo: 'codigo_distinto_en_registro', fuenteId: id, codigoHoja: g.codigo, codigosRegistro: cods, nombreHoja: g.nombre, nombreRegistro: d.nombre_entidad });
      if (g.nombre && d.nombre_entidad && !similar(g.nombre, d.nombre_entidad)) informe.nombresDistintos.push({ fuenteId: id, codigo: g.codigo, nombreHoja: g.nombre, nombreRegistro: d.nombre_entidad });
      const pa = g.provincia && (reconocerZona(g.provincia)?.provincia || g.provincia), pb = d.provincia && (reconocerZona(d.provincia)?.provincia || d.provincia);
      if (pa && pb && normalizeName(pa) !== normalizeName(pb)) informe.conflictos.push({ tipo: 'provincia_distinta', fuenteId: id, codigo: g.codigo, hoja: g.provincia, registro: d.provincia, nombre: d.nombre_entidad, url: d.url });
      if (g.aliasDe) informe.aliasDocumentales.push({ fuenteId: id, codigo: g.codigo, duplicadoDe: g.aliasDe });
      if (g.estado && g.estado !== 'descubierta' && (d.estado === 'descubierta' || !d.estado) && g.estado !== d.estado) informe.cambiosDeEstado[g.estado] = (informe.cambiosDeEstado[g.estado] || 0) + 1;
    }
    planFinal.push({ accion: 'fusionar', fuenteId: id, por: ps[0].por, filas: [principal, ...filasDest.filter(f => f !== principal)] });
  }
  for (const r of registro) { if (!urlClave(r.data)) informe.registroSinUrl.push({ fuenteId: r.id, nombre: r.data.nombre_entidad ?? null, canal: r.data.canal ?? null }); }
  for (const [k, rs] of porClave) if (rs.length > 1) informe.registroDuplicadoPorUrl.push({ urlClave: k, fuenteIds: rs.map(r => r.id) });
  const resumen = { filasHoja: filas.length, registroMcp: registro.length, seImportan: informe.importar.length, seFusionanConRegistro: informe.fusionarConRegistro.length, emparejadasPor: informe.emparejadasPor, aliasDocumentales: informe.aliasDocumentales.length, codigosReasignados: informe.codigosReasignados.length, cambiosDeEstado: informe.cambiosDeEstado, conflictos: informe.conflictos.length, pendientesRevision: informe.pendientesRevision.length, ambiguos: informe.ambiguos.length, nombresDistintosMismaUrl: informe.nombresDistintos.length, sinUrl: informe.sinUrl.length, enlacesSinResolver: informe.enlacesSinResolver.length, sinCodigo: informe.sinCodigo.length, codigosDuplicadosEnHoja: informe.codigosDuplicadosEnHoja.length, registroSinUrl: informe.registroSinUrl.length, registroDuplicadoPorUrl: informe.registroDuplicadoPorUrl.length };
  return { informe: { resumen, ...informe }, plan: planFinal, huella: hash(JSON.stringify(planFinal.map(p => [p.accion, p.fuenteId || null, p.filas.map(x => x.codigo || x.fila)]))).slice(0, 16) };
}

/** Documento de `registro_fuentes` para una fila nueva de la hoja. Nunca pisa nada: solo se usa con create:true. */
export function documentoNuevo(grupo, { ahora, actor = 'migracion' }) {
  const f = grupo[0], extra = grupo.slice(1), canon = (() => {
    if (!f.urlCruda || f.sinResolver) return null;
    const host = (() => { try { return new URL(f.urlCruda).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const canal = host === 'instagram.com' ? 'instagram' : host === 'tiktok.com' ? 'tiktok' : 'web';
    try { return canonicalSource({ canal, url: f.urlCruda }); } catch { return null; }
  })();
  const id = canon ? sourceId(canon.canal, canon.identificador) : 'fte_hoja_' + hash(f.codigo || `fila-${f.fila}`).slice(0, 24);
  const estado = f.sinResolver ? 'pausada' : (f.estado || 'activa'), nombre = f.nombre || (f.codigo ? `Fuente ${f.codigo}` : `Fuente fila ${f.fila}`);
  const d = {
    id, codigo: f.codigo, nombre_entidad: nombre, tipo: f.tipo, ambito: f.ambito || (f.municipio ? 'municipio' : (f.provincia ? 'provincia' : null)), region: f.ccaa, provincia: f.provincia, comarca: f.comarca, municipio: f.municipio, zona: f.zona,
    canal: canon?.canal ?? 'web', identificador: canon?.identificador ?? null, url: canon?.url ?? f.urlCruda ?? null, tipo_original: f.tipoOriginal, patron_publicacion: f.patron, origen_detalle: f.origen, canal_hoja: f.canalHoja, url_normalizada: f.urlClave, redes: Object.keys(f.redes).length ? f.redes : null, email: f.email, telefono: f.telefono,
    frecuencia_dias: f.frecuenciaDias || 7, ultima_revision: f.ultimaRevision, proxima_revision: f.ultimaRevision ? new Date(Date.parse(f.ultimaRevision) + (f.frecuenciaDias || 7) * 86400000).toISOString() : null,
    responsable: f.responsable, estado, motivo_bloqueo: estado === 'bloqueada' ? { texto: String(f.notas || `Marcada «${f.estadoCrudo}» en la hoja de fuentes (sin detalle)`).slice(0, 500), licenciaUrl: null } : null,
    eventos_aportados: grupo.reduce((n, x) => n + (x.eventos || 0), 0), ultimo_evento_encontrado: null, origen: 'hoja_fuentes_amalia', notas: [f.notas, f.sinResolver ? `Enlace sin resolver: ${f.urlCruda}` : null, extra.length ? `Filas fusionadas de la hoja: ${extra.map(x => x.codigo || x.fila).join(', ')}` : null].filter(Boolean).join(' | ') || null,
    codigos_alternativos: extra.map(x => x.codigo).filter(Boolean), via: 'Importada de la hoja «Fuentes actuales amalia»', negocio_id: null, plan_solicitado: null, periodo_solicitado: null, contacto: null, consentimiento: null, incidencia: null, reclamaciones: [], fallos_seguidos: 0, claim: null,
    creada_por: actor, creada_en: ahora, modificada_por: actor, modificada_en: ahora, fuera_de_territorio: false
  };
  return { id, data: d };
}
/** Campos que se pueden completar en una fuente existente sin pisar nada que ya tenga valor. */
export function huecosPorCompletar(d, grupo) {
  const f = grupo[0], set = {}, cand = { codigo: f.codigo, tipo: f.tipo, comarca: f.comarca, zona: f.zona, email: f.email, telefono: f.telefono, responsable: f.responsable, region: f.ccaa, provincia: f.provincia, municipio: f.municipio };
  for (const [k, v] of Object.entries(cand)) if (v && (d[k] == null || d[k] === '')) set[k] = v;
  if (Object.keys(f.redes).length && !d.redes) set.redes = f.redes;
  if (f.frecuenciaDias && d.frecuencia_dias == null) set.frecuencia_dias = f.frecuenciaDias;
  // url_normalizada NUNCA se toma de la hoja: la columna URL puede ser la web de la entidad aunque la fuente sea su perfil de Instagram. Se calcula siempre desde la url propia de la fuente (urlClave).
  if (f.ultimaRevision && !d.ultima_revision) { set.ultima_revision = f.ultimaRevision; set.proxima_revision = new Date(Date.parse(f.ultimaRevision) + (d.frecuencia_dias || f.frecuenciaDias || 7) * 86400000).toISOString(); }
  const alt = [...new Set(grupo.map(x => x.codigo).filter(c => c && c !== (d.codigo ?? set.codigo)))]; if (alt.length) set.codigos_alternativos = [...new Set([...(d.codigos_alternativos || []), ...alt])];
  if (f.notas && !d.notas) set.notas = f.notas;
  if (f.eventos > 0 && !(Number(d.eventos_aportados) > 0)) set.eventos_aportados = f.eventos;
  // El registro nace «descubierta»; si la hoja ya sabe más (activa, bloqueada, descartada, pausada), se adopta. Nunca se degrada un estado que ya no sea «descubierta».
  if (f.estado && f.estado !== 'descubierta' && (d.estado === 'descubierta' || !d.estado)) { set.estado = f.estado; if (f.estado === 'bloqueada' && !d.motivo_bloqueo) set.motivo_bloqueo = { texto: String(f.notas || `Marcada «${f.estadoCrudo}» en la hoja de fuentes (sin detalle)`).slice(0, 500), licenciaUrl: null }; }
  if (f.aliasDe && !d.duplicado_de) set.duplicado_de = f.aliasDe;
  if (f.codigoOriginal && !d.codigo_hoja_original) set.codigo_hoja_original = f.codigoOriginal;
  if (f.tipoOriginal && !d.tipo_original) set.tipo_original = f.tipoOriginal;
  if (f.patron && !d.patron_publicacion) set.patron_publicacion = f.patron;
  return set;
}

export function parseCsv(texto) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (q) { if (c === '"') { if (texto[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && texto[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x !== '')) rows.push(row); row = []; } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some(x => x !== '')) rows.push(row); }
  return rows;
}
