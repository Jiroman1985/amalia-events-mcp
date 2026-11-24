import test from 'node:test';
import assert from 'node:assert/strict';
import { publicar, responder, listar, misPendientes, marcarLeido, resolver, decidirHilo, agenteDe, recalcularAtencion, planAtencion, barrido, CAMPO_ATENCION } from '../tablon.mjs';
import { listarZonas, asignarZona, reasignarFuentesZona } from '../zonas.mjs';

class Store {
  constructor(seed = []) { this.docs = new Map(seed.map(r => [r.col + '/' + r.id, { id: r.id, data: r.data, updateTime: '1' }])); this.writes = []; this.n = 1; }
  async get(c, id) { const r = this.docs.get(c + '/' + id); return r ? { id, data: structuredClone(r.data), updateTime: r.updateTime } : null; }
  async list(c, { cursor, limit = 500 } = {}) { return [...this.docs].filter(([k]) => k.startsWith(c + '/')).map(([, r]) => r).sort((a, b) => (a.id < b.id ? -1 : 1)).filter(r => !cursor || r.id > cursor).slice(0, limit).map(r => ({ id: r.id, data: structuredClone(r.data), updateTime: r.updateTime })); }
  async write(c, id, data, o = {}) {
    const k = c + '/' + id, cur = this.docs.get(k);
    if (o.create && cur) { const e = new Error('version_conflict'); e.code = 'version_conflict'; throw e; }
    if (!o.create && cur && o.updateTime !== cur.updateTime) { const e = new Error('version_conflict'); e.code = 'version_conflict'; throw e; }
    this.writes.push({ c, id, data: structuredClone(data), create: !!o.create }); this.docs.set(k, { id, data: structuredClone(data), updateTime: String(++this.n) }); return {};
  }
}
const P = (id, actions) => ({ id, actions, businesses: ['*'] });
const alfred = P('alfred', ['read', 'board', 'board_admin', 'register_source']), alfredAltas = P('alfred-altas', ['read', 'board']);
const rene = P('rene', ['read', 'board', 'register_source']), conchi = P('conchi', ['read', 'board']), hark = P('hark', ['read', 'board']);
const lola = P('lola-panel', ['board_read']), sinBoard = P('claude-ingesta', ['read', 'admit']);
let reloj = 0; const now = () => new Date(Date.UTC(2026, 10, 21, 10, 0, reloj++)).toISOString();
const code = p => p.then(() => null, e => e.code);

test('agenteDe: los principales de un mismo agente comparten identidad', () => {
  assert.equal(agenteDe('alfred-altas'), 'alfred'); assert.equal(agenteDe('amalia-asistente'), 'amalia'); assert.equal(agenteDe('rene'), 'rene');
});

test('permisos: sin board no se lee ni escribe; board_read solo lee; decidir y reparto exigen board_admin', async () => {
  const s = new Store();
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'Hola', texto: 'x' }, sinBoard)), 'forbidden');
  assert.equal(await code(listar(s, {}, sinBoard)), 'forbidden');
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'Hola', texto: 'x' }, lola)), 'forbidden');
  assert.equal((await listar(s, {}, lola)).total, 0);
  const r = await publicar(s, { tipo: 'duda', asunto: 'Duda', texto: 'texto' }, rene, { now });
  assert.equal(await code(decidirHilo(s, { hilo: r.hilo, decision: 'ok' }, rene)), 'forbidden');
  assert.equal(await code(asignarZona(s, { zona: 'Madrid', agente: 'rene', motivo: 'reparto inicial' }, conchi)), 'forbidden');
  assert.equal(await code(reasignarFuentesZona(s, { zona: 'Madrid', agente: 'rene' }, conchi)), 'forbidden');
  assert.equal(await code(publicar(s, { tipo: 'decision', asunto: 'Decisión', texto: 'x' }, rene)), 'forbidden'); // las decisiones solo las registra Alfred
});

test('publicar: el autor sale del token; duda, ayuda y cambio de zona llegan siempre a Alfred; validaciones', async () => {
  const s = new Store();
  const a = await publicar(s, { tipo: 'duda', asunto: '¿Fuente duplicada?', texto: 'Creo que es la misma que F-MAL-0048', destinatarios: ['conchi'], autor: 'alfred' }, rene, { now });
  const d = s.docs.get('tablon_agentes/' + a.id).data;
  assert.equal(d.autor, 'rene'); assert.equal(d.agente, 'rene'); assert.deepEqual(d.destinatarios, ['conchi', 'alfred']); assert.equal(d.estado, 'abierto'); assert.equal(d.hilo, d.id);
  const b = await publicar(s, { tipo: 'aviso', asunto: 'Aviso general', texto: 'Cambio de horario', prioridad: 'urgente', referencias: { zona: 'Madrid', fuenteIds: ['fte_web_abcdef'] } }, hark, { now });
  assert.deepEqual(s.docs.get('tablon_agentes/' + b.id).data.destinatarios, ['todos']);
  assert.equal(await code(publicar(s, { tipo: 'inventado', asunto: 'abc', texto: 'x' }, hark)), 'board_tipo_invalido');
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'ab', texto: 'x' }, hark)), 'board_asunto_invalido');
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'abc', texto: 'x'.repeat(2001) }, hark)), 'board_texto_invalido');
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'abc', texto: 'x', destinatarios: ['Nombre Con Espacios'] }, hark)), 'board_destinatarios_invalidos');
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'abc', texto: 'x', referencias: { fuenteIds: ['no válido!'] } }, hark)), 'board_referencias_invalidas');
});

test('límite de frecuencia por agente', async () => {
  const s = new Store(), x = P('ritmo-test', ['board']);
  for (let i = 0; i < 30; i++) await publicar(s, { tipo: 'nota', asunto: 'Nota ' + i, texto: 'x' }, x, { now });
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'Una más', texto: 'x' }, x)), 'board_rate_limited');
});

test('hilo: responder, no editar ni borrar, resolver y bloqueo de respuestas en hilos resueltos', async () => {
  const s = new Store(); const raiz = await publicar(s, { tipo: 'ayuda', asunto: 'Necesito ayuda con Cáceres', texto: 'Hay 40 fuentes sin revisar' }, rene, { now });
  const r1 = await responder(s, { hilo: raiz.hilo, texto: 'Te echo una mano' }, conchi, { now });
  assert.deepEqual(r1.destinatarios.sort(), ['alfred', 'rene']);
  const conv = await listar(s, { hilo: raiz.hilo }, hark); assert.deepEqual(conv.mensajes.map(m => m.agente), ['rene', 'conchi']);
  assert.equal(await code(resolver(s, { hilo: raiz.hilo }, hark)), 'forbidden'); // ajeno al hilo
  assert.equal((await resolver(s, { hilo: raiz.hilo, nota: 'Resuelto entre los dos' }, rene, { now })).resuelto, true);
  assert.equal((await listar(s, { hilo: raiz.hilo }, hark)).mensajes.length, 3);
  assert.equal(await code(responder(s, { hilo: raiz.hilo, texto: 'tarde' }, conchi)), 'board_hilo_resuelto');
  assert.equal((await resolver(s, { hilo: raiz.hilo }, rene)).yaResuelto, true);
  assert.equal((await responder(s, { hilo: raiz.hilo, texto: 'Alfred puede reabrir la conversación' }, alfred, { now })).publicado, true);
  // inmutabilidad: ningún mensaje se reescribe; la única actualización permitida es el estado de la raíz
  const reescritos = s.writes.filter(w => !w.create); assert.equal(reescritos.length, 1); assert.equal(reescritos[0].id, raiz.hilo); assert.equal(reescritos[0].data.texto, 'Hay 40 fuentes sin revisar');
  assert.equal(await code(responder(s, { hilo: 'msg_inexistente', texto: 'x' }, conchi)), 'board_hilo_no_encontrado');
});

test('mis_pendientes y lectura: Alfred ve las dudas sin responder; marcar_leido las baja; urgentes primero', async () => {
  const s = new Store(), ahora = { now: () => '2026-11-21T10:30:00.000Z' };   // el autocierre usa el reloj: dentro de las 6 h del hilo
  const d1 = await publicar(s, { tipo: 'duda', asunto: 'Duda 1', texto: 'a' }, rene, { now });
  const d2 = await publicar(s, { tipo: 'cambio_zona', asunto: 'Cambio de zona', texto: 'Quiero Toledo', prioridad: 'urgente' }, conchi, { now });
  await publicar(s, { tipo: 'nota', asunto: 'Nota privada', texto: 'solo hark', destinatarios: ['hark'] }, conchi, { now });
  const p = await misPendientes(s, alfredAltas, ahora); // otro principal de Alfred: misma bandeja
  assert.equal(p.agente, 'alfred'); assert.equal(p.total, 2); assert.equal(p.urgentes, 1); assert.equal(p.pendientes[0].hilo, d2.hilo); assert.equal(p.pendientes[0].esperaMiRespuesta, true);
  assert.equal((await misPendientes(s, hark, ahora)).total, 1); assert.equal((await misPendientes(s, lola, ahora)).total, 0);
  await marcarLeido(s, { hilo: d1.hilo }, alfred, { now });
  const q = await misPendientes(s, alfred, ahora); assert.equal(q.pendientes.find(i => i.hilo === d1.hilo).sinLeer, 0); assert.equal(q.pendientes.find(i => i.hilo === d1.hilo).esperaMiRespuesta, true);
  await decidirHilo(s, { hilo: d1.hilo, decision: 'Es la misma fuente: no la registres' }, alfred, { now });
  assert.equal((await misPendientes(s, alfred, ahora)).total, 1);
  const al = await misPendientes(s, rene, ahora); assert.equal(al.total, 0); // el hilo ya está resuelto
  const l = await listar(s, { estado: 'abierto', soloSinLeer: true, soloMios: true }, rene, ahora); assert.equal(l.total, 0);
  await marcarLeido(s, { todos: true }, alfred, { now }); assert.equal((await listar(s, { soloSinLeer: true }, alfred, ahora)).total, 0);
  assert.equal(await code(marcarLeido(s, { hilo: 'msg_no_existe' }, alfred)), 'board_hilo_no_encontrado');
});

test('decidir_hilo: solo Alfred registra la decisión en el hilo y lo cierra', async () => {
  const s = new Store(); const d = await publicar(s, { tipo: 'duda', asunto: '¿Quién cubre Soria?', texto: 'Nadie la tiene' }, hark, { now });
  const r = await decidirHilo(s, { hilo: d.hilo, decision: 'La cubre Conchi desde hoy' }, alfred, { now });
  assert.equal(r.cerrado, true); const conv = await listar(s, { hilo: d.hilo }, hark);
  assert.equal(conv.estado, 'resuelto'); assert.equal(conv.mensajes.at(-1).tipo, 'decision'); assert.equal(conv.mensajes.at(-1).agente, 'alfred'); assert.deepEqual(conv.mensajes.at(-1).destinatarios.sort(), ['alfred', 'hark'].filter(x => x !== 'alfred'));
});

test('filtros del listado: tipo, autor, destinatario, zona y paginación', async () => {
  const s = new Store();
  for (let i = 0; i < 5; i++) await publicar(s, { tipo: i % 2 ? 'aviso' : 'duda', asunto: 'Mensaje ' + i, texto: 'x', referencias: i === 0 ? { zona: 'Madrid' } : undefined }, i % 2 ? hark : rene, { now });
  assert.equal((await listar(s, { tipo: 'duda' }, conchi)).total, 3); assert.equal((await listar(s, { autor: 'hark' }, conchi)).total, 2);
  assert.equal((await listar(s, { zona: 'madrid' }, conchi)).total, 1); assert.equal((await listar(s, { destinatario: 'alfred' }, conchi)).total, 5);
  const pag = await listar(s, { limite: 2, desplazamiento: 2 }, conchi); assert.equal(pag.devueltos, 2); assert.equal(pag.hayMas, true);
});

test('zonas: asignar guarda historial y avisa en el tablón; reasignar fuentes exige simular y código', async () => {
  const fte = (id, o) => ({ col: 'registro_fuentes', id, data: { id, nombre_entidad: 'F ' + id, canal: 'web', url: 'https://x.es/' + id, identificador: 'x.es/' + id, provincia: 'Madrid', responsable: 'conchi', ...o } });
  const s = new Store([fte('fte_web_a1', {}), fte('fte_web_a2', { responsable: 'rene' }), fte('fte_web_a3', { provincia: 'Cáceres' }), fte('fte_web_a4', { estado: 'fusionada' })]);
  const a = await asignarZona(s, { zona: 'Madrid', agente: 'rene', motivo: 'Reparto inicial de zonas' }, alfred, { now });
  assert.equal(a.asignada, true); assert.equal(a.anterior, null);
  assert.equal((await asignarZona(s, { zona: 'madrid', agente: 'rene', motivo: 'sin cambios' }, alfred)).yaAsignada, true);
  const b = await asignarZona(s, { zona: 'Madrid', agente: 'hark', motivo: 'Alfie pasa a Extremadura' }, alfred, { now }); assert.equal(b.anterior, 'rene');
  const z = await listarZonas(s, {}, lola); assert.deepEqual(z.porAgente, { hark: ['Madrid'] }); assert.equal(z.zonas[0].cambios, 1);
  const hilos = await listar(s, { tipo: 'asignacion' }, conchi); assert.equal(hilos.total, 2); assert.ok(hilos.hilos.every(h => h.estado === 'resuelto'));
  const sim = await reasignarFuentesZona(s, { zona: 'Madrid', agente: 'hark' }, alfred);
  assert.equal(sim.modo, 'simular'); assert.equal(sim.fuentesQueCambian, 2); assert.deepEqual(sim.responsableActual, { conchi: 1, rene: 1 });
  const antes = s.writes.length; assert.equal(await code(reasignarFuentesZona(s, { zona: 'Madrid', agente: 'hark', modo: 'aplicar', codigoConfirmacion: 'falso' }, alfred)), 'board_confirmacion_invalida'); assert.equal(s.writes.length, antes);
  const ok = await reasignarFuentesZona(s, { zona: 'Madrid', agente: 'hark', modo: 'aplicar', codigoConfirmacion: sim.codigoConfirmacion, motivo: 'Reparto de Madrid' }, alfred, { now });
  assert.equal(ok.reasignadas, 2); assert.equal(ok.restantes, 0);
  const f = s.docs.get('registro_fuentes/fte_web_a1').data; assert.equal(f.responsable, 'hark'); assert.equal(f.modificada_por, 'alfred'); assert.equal(f.historial.at(-1).cambios[0].antes, 'conchi');
  assert.equal(s.docs.get('registro_fuentes/fte_web_a3').data.responsable, 'conchi'); assert.equal(s.docs.get('registro_fuentes/fte_web_a4').data.responsable, 'conchi'); // otra provincia y fusionada: intactas
  assert.equal((await reasignarFuentesZona(s, { zona: 'Madrid', agente: 'hark' }, alfred)).fuentesQueCambian, 0);
});

// ---- autocierre, límite y requiereAtencion ----
const hilo = (s, id) => s.docs.get('tablon_agentes/' + id).data;
const en = (base, ms) => () => new Date(Date.parse(base) + ms).toISOString();
const T0 = '2026-11-22T08:00:00.000Z';

test('autocierre: un aviso se cierra solo cuando TODOS sus destinatarios lo han leído', async () => {
  const s = new Store(), t = (n) => en(T0, n * 1000);
  const p = await publicar(s, { tipo: 'aviso', asunto: 'Cambio de horario', texto: 'x', destinatarios: ['conchi', 'hark'] }, rene, { now: t(1) });
  await marcarLeido(s, { hilo: p.id }, conchi, { now: t(10) });
  assert.equal(hilo(s, p.id).estado, 'abierto', 'falta hark');
  await marcarLeido(s, { hilo: p.id }, hark, { now: t(20) });
  const d = hilo(s, p.id); assert.equal(d.estado, 'resuelto'); assert.equal(d.resuelto_por, 'sistema'); assert.equal(d.nota, 'autocierre'); assert.equal(d.autocierre_motivo, 'leido_por_todos');
  const v = await listar(s, { hilo: p.id }, conchi); assert.equal(v.estado, 'resuelto'); assert.equal(v.resueltoPor, 'sistema'); assert.equal(v.nota, 'autocierre');
});

test('autocierre: nota y asignacion también; evento, duda, ayuda y cambio_zona nunca, ni leídos por todos ni a las 6 h', async () => {
  const s = new Store(), t = (n) => en(T0, n * 1000), ids = {};
  for (const tipo of ['nota', 'asignacion', 'evento', 'duda', 'ayuda', 'cambio_zona'])
    ids[tipo] = (await publicar(s, { tipo, asunto: 'Hilo ' + tipo, texto: 'x', destinatarios: ['conchi', 'alfred'] }, rene, { now: t(1) })).id;
  for (const ag of [conchi, alfred]) await marcarLeido(s, { todos: true }, ag, { now: t(30) });
  assert.equal(hilo(s, ids.nota).estado, 'resuelto'); assert.equal(hilo(s, ids.asignacion).estado, 'resuelto');
  for (const tipo of ['evento', 'duda', 'ayuda', 'cambio_zona']) assert.equal(hilo(s, ids[tipo]).estado, 'abierto', tipo);
  await listar(s, {}, alfred, { now: en(T0, 7 * 3600 * 1000) });
  for (const tipo of ['evento', 'duda', 'ayuda', 'cambio_zona']) assert.equal(hilo(s, ids[tipo]).estado, 'abierto', tipo + ' a las 7 h');
});

test('autocierre: a las 6 h de creado se cierra aunque nadie lo haya leído (ni a las 5 h 59 min)', async () => {
  const s = new Store();
  const p = await publicar(s, { tipo: 'nota', asunto: 'Sin leer', texto: 'x', destinatarios: ['conchi'] }, rene, { now: en(T0, 0) });
  await listar(s, {}, alfred, { now: en(T0, 6 * 3600 * 1000 - 60000) }); assert.equal(hilo(s, p.id).estado, 'abierto');
  await misPendientes(s, conchi, { now: en(T0, 6 * 3600 * 1000) });
  const d = hilo(s, p.id); assert.equal(d.estado, 'resuelto'); assert.equal(d.resuelto_por, 'sistema'); assert.equal(d.autocierre_motivo, 'seis_horas');
});

test('autocierre: «todos» exige a todos los agentes (si no, 6 h); el autor no cuenta; una respuesta nueva vuelve a pedir lectura', async () => {
  const s = new Store(), t = (n) => en(T0, n * 1000);
  const todos = await publicar(s, { tipo: 'aviso', asunto: 'Para todos', texto: 'x' }, rene, { now: t(1) });
  for (const ag of [conchi, hark, alfred]) await marcarLeido(s, { hilo: todos.id }, ag, { now: t(5) });
  assert.equal(hilo(s, todos.id).estado, 'abierto', 'faltan agentes de «todos»');
  const aMi = await publicar(s, { tipo: 'aviso', asunto: 'A mí mismo', texto: 'x', destinatarios: ['rene'] }, rene, { now: t(2) });
  await marcarLeido(s, { hilo: aMi.id }, rene, { now: t(6) }); assert.equal(hilo(s, aMi.id).estado, 'abierto', 'sin lectores no se cierra por lectura');
  const a = await publicar(s, { tipo: 'aviso', asunto: 'Con réplica', texto: 'x', destinatarios: ['conchi', 'hark'] }, rene, { now: t(10) });
  await marcarLeido(s, { hilo: a.id }, conchi, { now: t(12) });
  await responder(s, { hilo: a.id, texto: 'matiz', destinatarios: ['conchi', 'hark'] }, rene, { now: t(14) });
  await marcarLeido(s, { hilo: a.id }, hark, { now: t(16) });
  assert.equal(hilo(s, a.id).estado, 'abierto', 'conchi no ha leído la réplica');
  await marcarLeido(s, { hilo: a.id }, conchi, { now: t(18) }); assert.equal(hilo(s, a.id).estado, 'resuelto');
});

test('límite de mensajes: resolver_hilo (con nota) y marcar_leido no cuentan en los 30 cada 10 min', async () => {
  const s = new Store(), u = P('limite-ensayo', ['read', 'board']), ids = [];
  for (let i = 0; i < 25; i++) ids.push((await publicar(s, { tipo: 'duda', asunto: 'Duda ' + i, texto: 'x' }, u, { now })).id);
  for (const id of ids.slice(0, 20)) await resolver(s, { hilo: id, nota: 'resuelta' }, u, { now });
  for (let i = 0; i < 40; i++) await marcarLeido(s, { todos: true }, u, { now });
  for (let i = 0; i < 5; i++) await publicar(s, { tipo: 'nota', asunto: 'Nota ' + i, texto: 'x' }, u, { now });
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'La 31', texto: 'x' }, u)), 'board_rate_limited');
});

test('requiereAtencion: abierto + urgente + (duda, ayuda, cambio_zona o con esperaA)', async () => {
  const s = new Store(), ids = {};
  const pub = async (k, o) => { ids[k] = (await publicar(s, { asunto: 'Caso ' + k, texto: 'x', ...o }, rene, { now })).id; };
  await pub('duda_u', { tipo: 'duda', prioridad: 'urgente' }); await pub('ayuda_u', { tipo: 'ayuda', prioridad: 'urgente' }); await pub('zona_u', { tipo: 'cambio_zona', prioridad: 'urgente' });
  await pub('duda_n', { tipo: 'duda' }); await pub('aviso_u', { tipo: 'aviso', prioridad: 'urgente', destinatarios: ['conchi'] });
  await pub('aviso_u_espera', { tipo: 'aviso', prioridad: 'urgente', destinatarios: ['conchi'], esperaA: 'José Ignacio' }); await pub('nota_n_espera', { tipo: 'nota', destinatarios: ['conchi'], esperaA: 'José Ignacio' });
  await pub('duda_u_resuelta', { tipo: 'duda', prioridad: 'urgente' }); await resolver(s, { hilo: ids.duda_u_resuelta }, alfred, { now });
  const ahora = { now: () => '2026-11-21T10:30:00.000Z' };
  const r = await listar(s, {}, alfred, ahora), por = Object.fromEntries(r.hilos.map(h => [h.hilo, h]));
  const esperado = { duda_u: true, ayuda_u: true, zona_u: true, duda_n: false, aviso_u: false, aviso_u_espera: true, nota_n_espera: false, duda_u_resuelta: false };
  for (const [k, v] of Object.entries(esperado)) assert.equal(por[ids[k]].requiereAtencion, v, k);
  assert.equal(por[ids.aviso_u_espera].esperaA, 'José Ignacio'); assert.equal(r.requierenAtencion, 4);
  assert.equal((await listar(s, { hilo: ids.duda_u }, alfred)).requiereAtencion, true);
  const mp = await misPendientes(s, alfred, ahora); assert.ok(mp.pendientes.filter(i => i.requiereAtencion).every(i => i.prioridad === 'urgente'));
  assert.equal(mp.requierenAtencion, mp.pendientes.filter(i => i.requiereAtencion).length);
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'Mala espera', texto: 'x', esperaA: 'x' }, rene)), 'board_espera_a_invalido');
});

// ---- requiere_atencion guardado en la raíz del hilo (tablon_agentes) ----
let nTest = 0; const frescos = () => { nTest++; return { autor: P('ra-autor-' + nTest, ['read', 'board']), adm: P('ra-adm-' + nTest, ['read', 'board', 'board_admin']) }; };
const ra = (s, id) => s.docs.get('tablon_agentes/' + id).data.requiere_atencion;
const T1 = { now: () => '2026-11-21T10:30:00.000Z' };

test('requiere_atencion: se guarda en el documento raíz al publicar (campo booleano exacto)', async () => {
  assert.equal(CAMPO_ATENCION, 'requiere_atencion');
  const s = new Store(), ids = {}, { autor: rene } = frescos();
  const pub = async (k, o) => { ids[k] = (await publicar(s, { asunto: 'Caso ' + k, texto: 'x', ...o }, rene, { now })).id; };
  await pub('duda_u', { tipo: 'duda', prioridad: 'urgente' }); await pub('duda_n', { tipo: 'duda' }); await pub('aviso_u', { tipo: 'aviso', prioridad: 'urgente', destinatarios: ['conchi'] });
  await pub('aviso_u_espera', { tipo: 'aviso', prioridad: 'urgente', destinatarios: ['conchi'], esperaA: 'José Ignacio' });
  assert.deepEqual([ra(s, ids.duda_u), ra(s, ids.duda_n), ra(s, ids.aviso_u), ra(s, ids.aviso_u_espera)], [true, false, false, true]);
  assert.ok(s.writes.every(w => w.c === 'tablon_agentes'));
});

test('requiere_atencion: resolver, decidir (y decidir sin cerrar) y el autocierre lo recalculan', async () => {
  const s = new Store(), t = n => en(T0, n * 1000), { autor: rene, adm: alfred } = frescos();
  const a = await publicar(s, { tipo: 'duda', asunto: 'Duda a', texto: 'x', prioridad: 'urgente' }, rene, { now }), b = await publicar(s, { tipo: 'ayuda', asunto: 'Ayuda b', texto: 'x', prioridad: 'urgente' }, rene, { now });
  const c = await publicar(s, { tipo: 'cambio_zona', asunto: 'Zona c', texto: 'x', prioridad: 'urgente' }, rene, { now }), d = await publicar(s, { tipo: 'aviso', asunto: 'Aviso d', texto: 'x', prioridad: 'urgente', destinatarios: ['conchi'], esperaA: 'Alfred' }, rene, { now: t(0) });
  assert.deepEqual([a, b, c, d].map(x => ra(s, x.id)), [true, true, true, true]);
  await resolver(s, { hilo: a.id, nota: 'ok' }, alfred, { now }); assert.equal(ra(s, a.id), false);
  await decidirHilo(s, { hilo: b.id, decision: 'Hecho', cerrar: false }, alfred, { now }); assert.equal(ra(s, b.id), true, 'sigue abierto');
  await decidirHilo(s, { hilo: c.id, decision: 'Hecho' }, alfred, { now }); assert.equal(ra(s, c.id), false);
  await listar(s, {}, alfred, { now: en(T0, 6 * 3600 * 1000) }); assert.equal(hilo(s, d.id).estado, 'resuelto'); assert.equal(ra(s, d.id), false, 'el autocierre lo baja a false');
  assert.ok([a, b, c, d].every(x => typeof ra(s, x.id) === 'boolean'));
});

test('requiere_atencion: responder y marcar_leido corrigen un valor ausente o desfasado sin tocar lo correcto', async () => {
  const s = new Store(), { autor: rene, adm: alfred } = frescos(), a = await publicar(s, { tipo: 'duda', asunto: 'Duda a', texto: 'x', prioridad: 'urgente' }, rene, { now }), b = await publicar(s, { tipo: 'duda', asunto: 'Duda b', texto: 'x' }, rene, { now });
  const raiz = id => s.docs.get('tablon_agentes/' + id);
  delete raiz(a.id).data.requiere_atencion; raiz(b.id).data.requiere_atencion = true;   // hilo antiguo sin campo y otro desfasado
  await responder(s, { hilo: a.id, texto: 'miro' }, alfred, { now }); assert.equal(ra(s, a.id), true);
  const antes = s.writes.length; await responder(s, { hilo: a.id, texto: 'otra' }, alfred, { now });
  assert.equal(s.writes.filter((w, i) => i >= antes && w.id === a.id).length, 0, 'ya estaba bien: no se reescribe la raíz');
  await marcarLeido(s, { todos: true }, alfred, { now }); assert.equal(ra(s, b.id), false);
  assert.ok([...s.docs.values()].filter(r => r.data.es_raiz === false).every(r => !('requiere_atencion' in r.data)), 'las respuestas no llevan el campo');
});

test('requiere_atencion: el barrido (autocierre + recálculo) corrige todo el tablón', async () => {
  const s = new Store(), ids = [], { autor: rene } = frescos();
  for (let i = 0; i < 6; i++) ids.push((await publicar(s, { tipo: i % 2 ? 'duda' : 'aviso', asunto: 'Hilo ' + i, texto: 'x', prioridad: 'urgente', destinatarios: i % 2 ? undefined : ['conchi'], esperaA: i === 0 ? 'Alfred' : undefined }, rene, { now })).id);
  for (const id of ids) delete s.docs.get('tablon_agentes/' + id).data.requiere_atencion;
  const r = await barrido(s, T1); assert.equal(r.corregidos.length, 6);
  assert.deepEqual(ids.map(id => ra(s, id)), [true, true, false, true, false, true]);
  const r2 = await barrido(s, T1); assert.deepEqual(r2.corregidos, []);
  const tarde = await barrido(s, { now: en(T0, 24 * 3600 * 1000) }); assert.equal(tarde.cerrados.length, 3);
  assert.deepEqual(ids.map(id => ra(s, id)), [false, true, false, true, false, true]);
});

test('backfill: planAtencion cuenta las raíces que cambian; aplicar con recalcularAtencion deja el plan vacío', async () => {
  const raiz = (id, o) => ({ col: 'tablon_agentes', id, data: { id, hilo: id, es_raiz: true, autor: 'rene', agente: 'rene', tipo: 'duda', asunto: 'Asunto ' + id, texto: 'x', destinatarios: ['alfred'], prioridad: 'normal', estado: 'abierto', creado_en: '2026-11-20T10:00:00Z', ...o } });
  const s = new Store([raiz('msg_a', { prioridad: 'urgente' }), raiz('msg_b', {}), raiz('msg_c', { prioridad: 'urgente', estado: 'resuelto' }), raiz('msg_d', { tipo: 'nota', prioridad: 'urgente', espera_a: 'Alfred', destinatarios: ['conchi'] }), raiz('msg_e', { prioridad: 'urgente', requiere_atencion: true }), { col: 'tablon_agentes', id: 'msg_r', data: { id: 'msg_r', hilo: 'msg_a', es_raiz: false, texto: 'resp', creado_en: '2026-11-20T11:00:00Z' } }]);
  const rows = await s.list('tablon_agentes'), plan = planAtencion(rows);
  assert.equal(plan.raices, 5); assert.equal(plan.aTrue, 3); assert.deepEqual(plan.cambios.map(c => c.id).sort(), ['msg_a', 'msg_b', 'msg_c', 'msg_d']);
  assert.equal(plan.cambios.find(c => c.id === 'msg_e'), undefined, 'ya correcto');
  const hecho = await recalcularAtencion(s); assert.equal(hecho.length, 4);
  assert.deepEqual(['msg_a', 'msg_b', 'msg_c', 'msg_d', 'msg_e'].map(id => ra(s, id)), [true, false, false, true, true]);
  assert.deepEqual(planAtencion(await s.list('tablon_agentes')).cambios, []); assert.equal((await recalcularAtencion(s)).length, 0);
  assert.equal('requiere_atencion' in s.docs.get('tablon_agentes/msg_r').data, false);
});

// ---- agentes de baja como destinatarios ----
test('publicar_mensaje rechaza como destinatario a un agente de baja (también con alias o mayúsculas) y no escribe nada', async () => {
  const s = new Store(), u = P('baja-dest-ensayo', ['read', 'board']);
  for (const d of [['alfie'], ['conchi', 'Alfie'], ['  ALFIE ', 'noodle']]) {
    const e = await publicar(s, { tipo: 'aviso', asunto: 'Aviso a alguien de baja', texto: 'x', destinatarios: d }, u, { now }).then(() => null, e => e);
    assert.equal(e.code, 'board_destinatario_baja', JSON.stringify(d)); assert.deepEqual(e.details.agentes, ['alfie']); assert.match(e.details.ayuda, /de baja/);
  }
  assert.equal(s.writes.length, 0);
  const ok = await publicar(s, { tipo: 'aviso', asunto: 'Aviso válido', texto: 'x', destinatarios: ['noodle', 'conchi'] }, u, { now }); assert.equal(ok.publicado, true);
  assert.equal((await publicar(s, { tipo: 'nota', asunto: 'Para todos', texto: 'x', destinatarios: ['todos'] }, u, { now })).publicado, true);
});

test('responder: no se puede dirigir a un agente de baja, y las respuestas por defecto en hilos antiguos lo omiten', async () => {
  const antiguo = { col: 'tablon_agentes', id: 'msg_viejo1', data: { id: 'msg_viejo1', hilo: 'msg_viejo1', es_raiz: true, autor: 'alfie', agente: 'alfie', tipo: 'duda', asunto: 'Duda antigua', texto: 'x', destinatarios: ['alfred', 'conchi'], prioridad: 'normal', estado: 'abierto', creado_en: '2026-11-20T10:00:00Z' } };
  const s = new Store([antiguo]), u = P('baja-resp-ensayo', ['read', 'board']), adm = P('baja-adm-ensayo', ['read', 'board', 'board_admin']);
  assert.equal(await code(responder(s, { hilo: 'msg_viejo1', texto: 'y tú qué', destinatarios: ['alfie'] }, u, { now })), 'board_destinatario_baja');
  const r = await responder(s, { hilo: 'msg_viejo1', texto: 'te contesto' }, u, { now }); assert.ok(!r.destinatarios.includes('alfie')); assert.ok(r.destinatarios.includes('conchi'));
  const d = await decidirHilo(s, { hilo: 'msg_viejo1', decision: 'Cerrado por baja de Alfie' }, adm, { now }); assert.equal(d.decidido, true);
  const dec = [...s.docs.values()].find(x => x.data.tipo === 'decision'); assert.ok(!dec.data.destinatarios.includes('alfie'));
  assert.equal((await listar(s, { hilo: 'msg_viejo1' }, adm)).mensajes[0].autor, 'alfie', 'el autor histórico se sigue leyendo');
});
