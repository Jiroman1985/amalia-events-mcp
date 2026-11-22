// asignar_fuenteid.mjs — pone fuenteId a eventos de un agente que no lo tienen, buscando su fuente en registro_fuentes. ENSAYO por defecto (no escribe).
//   node asignar_fuenteid.mjs [--agente alfie] [--tarea tsk_…] [--pares pares.json] [--salida plan.json]
//   --pares: JSON {eventId: fuenteId} (p. ej. el ledger entregado por el agente). Se resuelve cada fuenteId a su canónico (fuentes fusionadas) y se contrasta con la URL del evento.
//   node asignar_fuenteid.mjs --aplicar --confirmo <huella> [--agente alfie]     (usa editar_evento: versión, motivo y auditoría; solo las asignaciones exactas)
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FirestoreStore } from './firestore-store.mjs';
import { EventService } from './event-service.mjs';
import { canonicalSource, matchRegistry, readRegistry } from './registro-fuentes.mjs';
import { agenteCanonico } from './identidad.mjs';
const arg = k => { const i = process.argv.indexOf('--' + k); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const agente = arg('agente') || 'alfie', tareaId = arg('tarea'), aplicar = process.argv.includes('--aplicar');
const store = new FirestoreStore({ project: process.env.FIRESTORE_PROJECT_ID, key: process.env.FIREBASE_API_KEY, credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const tarea = tareaId ? await store.get('tareas_agentes', tareaId) : null;
const registro = await readRegistry(store);
const eventos = await store.listAll('eventos', { max: 50000 });
const pares = arg('pares') ? JSON.parse(readFileSync(arg('pares'), 'utf8')) : null;
const porId = new Map(registro.map(r => [r.id, r]));
const canonico = id => { const vistos = new Set(); let r = porId.get(id), cadena = []; while (r && r.data.estado === 'fusionada' && !vistos.has(r.id)) { vistos.add(r.id); cadena.push(r.id); r = porId.get(r.data.duplicado_de || r.data.fusionada_en); } return { fila: r || null, cadena }; };
const candidatos = pares ? eventos.filter(r => r.id in pares) : eventos.filter(r => { const d = r.data; return agenteCanonico(d.createdBy || '') === agente && d.retirado !== true && d.prueba !== true && !d.fuenteId; });
const canonDe = u => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return canonicalSource({ canal: /instagram\.com$/.test(h) ? 'instagram' : /tiktok\.com$/.test(h) ? 'tiktok' : 'web', url: u }); } catch { return null; } };
const plan = [];
for (const r of candidatos) {
  const d = r.data, urls = [...(d.fuentes || []).map(f => f.url), d.link].filter(Boolean);
  const resumen = x => ({ fuenteId: x.fuenteId, nombre: x.nombreEntidad, url: x.url, estado: x.estado, motivos: x.motivos });
  let exactas = [], parecidas = [], probadas = 0;
  for (const u of urls) {
    const c = canonDe(u); if (!c) continue; probadas++;
    const m = matchRegistry(c, registro, { nombre: d.fuente_nombre, municipio: d.city });
    for (const e of m.exactas) if (!exactas.some(x => x.fuenteId === e.fuenteId)) exactas.push(e);
    for (const p of m.parecidas) if (!parecidas.some(x => x.fuenteId === p.fuenteId) && !exactas.some(x => x.fuenteId === p.fuenteId)) parecidas.push(p);
  }
  if (pares) {
    const prop = pares[r.id], { fila, cadena } = canonico(prop), porUrl = exactas.map(x => x.fuenteId);
    const accion = d.retirado === true ? 'evento_retirado' : d.fuenteId ? 'ya_tiene_fuenteId' : !fila ? 'fuente_no_existe' : fila.data.estado === 'descartada' || fila.data.estado === 'bloqueada' ? 'fuente_' + fila.data.estado : porUrl.length && !porUrl.includes(fila.id) && !porUrl.some(x => cadena.includes(x)) ? 'no_coincide_con_url' : 'asignar';
    plan.push({ eventId: r.id, negocioId: d.negocioId, version: d.version || 0, titulo: d.titulo, city: d.city, fechaLocal: d.fechaLocal, url: urls[0] || null, accion, fuenteIdLedger: prop, fusionadaHacia: cadena.length ? fila?.id ?? null : null, fuenteIdPropuesta: accion === 'asignar' ? fila.id : null, fuente: fila ? { fuenteId: fila.id, nombre: fila.data.nombre_entidad ?? null, url: fila.data.url ?? null, estado: fila.data.estado ?? null } : null, coincidePorUrl: porUrl.length ? (porUrl.includes(fila?.id) || porUrl.some(x => cadena.includes(x))) : null, candidatas: porUrl.includes(fila?.id) || porUrl.some(x => cadena.includes(x)) ? [] : [...exactas, ...parecidas].slice(0, 3).map(resumen) });
    continue;
  }
  const accion = exactas.length === 1 ? 'asignar' : exactas.length > 1 ? 'ambigua' : parecidas.length ? 'revisar' : 'sin_fuente_en_registro';
  plan.push({ eventId: r.id, negocioId: d.negocioId, version: d.version || 0, titulo: d.titulo, city: d.city, fechaLocal: d.fechaLocal, url: urls[0] || null, accion, fuenteIdPropuesta: accion === 'asignar' ? exactas[0].fuenteId : null, fuente: accion === 'asignar' ? resumen(exactas[0]) : null, candidatas: (exactas.length > 1 ? exactas : parecidas).slice(0, 5).map(resumen) });
}
const cuenta = plan.reduce((o, p) => (o[p.accion] = (o[p.accion] || 0) + 1, o), {});
const huella = createHash('sha256').update(JSON.stringify(plan.filter(p => p.accion === 'asignar').map(p => [p.eventId, p.version, p.fuenteIdPropuesta]))).digest('hex').slice(0, 16);
const sinEncontrar = pares ? Object.keys(pares).filter(id => !eventos.some(e => e.id === id)) : [];
const yaTienen = pares ? eventos.filter(e => e.id in pares && e.data.fuenteId).map(e => e.id) : [];
const informe = { generado: new Date().toISOString(), modo: aplicar ? 'APLICAR' : 'ENSAYO (no se ha escrito nada)', agente, tarea: tarea ? { id: tarea.id, titulo: tarea.data.titulo, estado: tarea.data.estado, detalle: tarea.data.detalle ?? null, referencias: tarea.data.referencias ?? null } : null, sinFuenteIdTotal: candidatos.length, ...(pares ? { paresRecibidos: Object.keys(pares).length, eventosInexistentes: sinEncontrar, yaTenianFuenteId: yaTienen } : {}), cuenta, huella, plan };
if (!aplicar) { const out = arg('salida'); if (out) writeFileSync(out, JSON.stringify(informe, null, 1)); console.log(JSON.stringify(out ? { ...informe, plan: undefined } : informe, null, 1)); process.exit(0); }
if (arg('confirmo') !== huella) { console.error('La huella no coincide: repite el ensayo. Actual: ' + huella); process.exit(2); }
const imagenActual = {}, ev = new EventService(store, { get: id => imagenActual[id] || { url: null, sourceUrl: null } }, { warm: false }), principal = { id: 'alfred-ediciones', actions: ['read', 'edit'], businesses: ['*'] }, resultado = [];
for (const p of plan.filter(x => x.accion === 'asignar')) {
  try { const d0 = (await store.get('eventos', p.eventId))?.data || {}; if (d0.assetId) imagenActual[d0.assetId] = { url: d0.image ?? null, sourceUrl: d0.sourceImageUrl ?? d0.image ?? null };
    const o = await ev.update({ eventId: p.eventId, negocioId: p.negocioId, expectedVersion: p.version, changes: { fuenteId: p.fuenteIdPropuesta }, reason: `Enlazar con la fuente del registro (tarea ${tareaId || 'fuenteId'})` }, principal); resultado.push({ eventId: p.eventId, ok: true, version: o.version }); }
  catch (e) { resultado.push({ eventId: p.eventId, ok: false, error: e.code || e.message }); }
}
console.log(JSON.stringify({ modo: 'APLICADO', resultado }, null, 1));
