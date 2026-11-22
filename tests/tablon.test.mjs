import test from 'node:test';
import assert from 'node:assert/strict';
import { publicar, responder, listar, misPendientes, marcarLeido, resolver, decidirHilo, agenteDe } from '../tablon.mjs';
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
const alfie = P('alfie', ['read', 'board', 'register_source']), conchi = P('conchi', ['read', 'board']), hark = P('hark', ['read', 'board']);
const lola = P('lola-panel', ['board_read']), sinBoard = P('claude-ingesta', ['read', 'admit']);
let reloj = 0; const now = () => new Date(Date.UTC(2026, 10, 21, 10, 0, reloj++)).toISOString();
const code = p => p.then(() => null, e => e.code);

test('agenteDe: los principales de un mismo agente comparten identidad', () => {
  assert.equal(agenteDe('alfred-altas'), 'alfred'); assert.equal(agenteDe('amalia-asistente'), 'amalia'); assert.equal(agenteDe('alfie'), 'alfie');
});

test('permisos: sin board no se lee ni escribe; board_read solo lee; decidir y reparto exigen board_admin', async () => {
  const s = new Store();
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'Hola', texto: 'x' }, sinBoard)), 'forbidden');
  assert.equal(await code(listar(s, {}, sinBoard)), 'forbidden');
  assert.equal(await code(publicar(s, { tipo: 'nota', asunto: 'Hola', texto: 'x' }, lola)), 'forbidden');
  assert.equal((await listar(s, {}, lola)).total, 0);
  const r = await publicar(s, { tipo: 'duda', asunto: 'Duda', texto: 'texto' }, alfie, { now });
  assert.equal(await code(decidirHilo(s, { hilo: r.hilo, decision: 'ok' }, alfie)), 'forbidden');
  assert.equal(await code(asignarZona(s, { zona: 'Madrid', agente: 'alfie', motivo: 'reparto inicial' }, conchi)), 'forbidden');
  assert.equal(await code(reasignarFuentesZona(s, { zona: 'Madrid', agente: 'alfie' }, conchi)), 'forbidden');
  assert.equal(await code(publicar(s, { tipo: 'decision', asunto: 'Decisión', texto: 'x' }, alfie)), 'forbidden'); // las decisiones solo las registra Alfred
});

test('publicar: el autor sale del token; duda, ayuda y cambio de zona llegan siempre a Alfred; validaciones', async () => {
  const s = new Store();
  const a = await publicar(s, { tipo: 'duda', asunto: '¿Fuente duplicada?', texto: 'Creo que es la misma que F-MAL-0048', destinatarios: ['conchi'], autor: 'alfred' }, alfie, { now });
  const d = s.docs.get('tablon_agentes/' + a.id).data;
  assert.equal(d.autor, 'alfie'); assert.equal(d.agente, 'alfie'); assert.deepEqual(d.destinatarios, ['conchi', 'alfred']); assert.equal(d.estado, 'abierto'); assert.equal(d.hilo, d.id);
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
  const s = new Store(); const raiz = await publicar(s, { tipo: 'ayuda', asunto: 'Necesito ayuda con Cáceres', texto: 'Hay 40 fuentes sin revisar' }, alfie, { now });
  const r1 = await responder(s, { hilo: raiz.hilo, texto: 'Te echo una mano' }, conchi, { now });
  assert.deepEqual(r1.destinatarios.sort(), ['alfie', 'alfred']);
  const conv = await listar(s, { hilo: raiz.hilo }, hark); assert.deepEqual(conv.mensajes.map(m => m.agente), ['alfie', 'conchi']);
  assert.equal(await code(resolver(s, { hilo: raiz.hilo }, hark)), 'forbidden'); // ajeno al hilo
  assert.equal((await resolver(s, { hilo: raiz.hilo, nota: 'Resuelto entre los dos' }, alfie, { now })).resuelto, true);
  assert.equal((await listar(s, { hilo: raiz.hilo }, hark)).mensajes.length, 3);
  assert.equal(await code(responder(s, { hilo: raiz.hilo, texto: 'tarde' }, conchi)), 'board_hilo_resuelto');
  assert.equal((await resolver(s, { hilo: raiz.hilo }, alfie)).yaResuelto, true);
  assert.equal((await responder(s, { hilo: raiz.hilo, texto: 'Alfred puede reabrir la conversación' }, alfred, { now })).publicado, true);
  // inmutabilidad: ningún mensaje se reescribe; la única actualización permitida es el estado de la raíz
  const reescritos = s.writes.filter(w => !w.create); assert.equal(reescritos.length, 1); assert.equal(reescritos[0].id, raiz.hilo); assert.equal(reescritos[0].data.texto, 'Hay 40 fuentes sin revisar');
  assert.equal(await code(responder(s, { hilo: 'msg_inexistente', texto: 'x' }, conchi)), 'board_hilo_no_encontrado');
});

test('mis_pendientes y lectura: Alfred ve las dudas sin responder; marcar_leido las baja; urgentes primero', async () => {
  const s = new Store();
  const d1 = await publicar(s, { tipo: 'duda', asunto: 'Duda 1', texto: 'a' }, alfie, { now });
  const d2 = await publicar(s, { tipo: 'cambio_zona', asunto: 'Cambio de zona', texto: 'Quiero Toledo', prioridad: 'urgente' }, conchi, { now });
  await publicar(s, { tipo: 'nota', asunto: 'Nota privada', texto: 'solo hark', destinatarios: ['hark'] }, conchi, { now });
  const p = await misPendientes(s, alfredAltas); // otro principal de Alfred: misma bandeja
  assert.equal(p.agente, 'alfred'); assert.equal(p.total, 2); assert.equal(p.urgentes, 1); assert.equal(p.pendientes[0].hilo, d2.hilo); assert.equal(p.pendientes[0].esperaMiRespuesta, true);
  assert.equal((await misPendientes(s, hark)).total, 1); assert.equal((await misPendientes(s, lola)).total, 0);
  await marcarLeido(s, { hilo: d1.hilo }, alfred, { now });
  const q = await misPendientes(s, alfred); assert.equal(q.pendientes.find(i => i.hilo === d1.hilo).sinLeer, 0); assert.equal(q.pendientes.find(i => i.hilo === d1.hilo).esperaMiRespuesta, true);
  await decidirHilo(s, { hilo: d1.hilo, decision: 'Es la misma fuente: no la registres' }, alfred, { now });
  assert.equal((await misPendientes(s, alfred)).total, 1);
  const al = await misPendientes(s, alfie); assert.equal(al.total, 0); // el hilo ya está resuelto
  const l = await listar(s, { estado: 'abierto', soloSinLeer: true, soloMios: true }, alfie); assert.equal(l.total, 0);
  await marcarLeido(s, { todos: true }, alfred, { now }); assert.equal((await listar(s, { soloSinLeer: true }, alfred)).total, 0);
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
  for (let i = 0; i < 5; i++) await publicar(s, { tipo: i % 2 ? 'aviso' : 'duda', asunto: 'Mensaje ' + i, texto: 'x', referencias: i === 0 ? { zona: 'Madrid' } : undefined }, i % 2 ? hark : alfie, { now });
  assert.equal((await listar(s, { tipo: 'duda' }, conchi)).total, 3); assert.equal((await listar(s, { autor: 'hark' }, conchi)).total, 2);
  assert.equal((await listar(s, { zona: 'madrid' }, conchi)).total, 1); assert.equal((await listar(s, { destinatario: 'alfred' }, conchi)).total, 5);
  const pag = await listar(s, { limite: 2, desplazamiento: 2 }, conchi); assert.equal(pag.devueltos, 2); assert.equal(pag.hayMas, true);
});

test('zonas: asignar guarda historial y avisa en el tablón; reasignar fuentes exige simular y código', async () => {
  const fte = (id, o) => ({ col: 'registro_fuentes', id, data: { id, nombre_entidad: 'F ' + id, canal: 'web', url: 'https://x.es/' + id, identificador: 'x.es/' + id, provincia: 'Madrid', responsable: 'conchi', ...o } });
  const s = new Store([fte('fte_web_a1', {}), fte('fte_web_a2', { responsable: 'alfie' }), fte('fte_web_a3', { provincia: 'Cáceres' }), fte('fte_web_a4', { estado: 'fusionada' })]);
  const a = await asignarZona(s, { zona: 'Madrid', agente: 'alfie', motivo: 'Reparto inicial de zonas' }, alfred, { now });
  assert.equal(a.asignada, true); assert.equal(a.anterior, null);
  assert.equal((await asignarZona(s, { zona: 'madrid', agente: 'alfie', motivo: 'sin cambios' }, alfred)).yaAsignada, true);
  const b = await asignarZona(s, { zona: 'Madrid', agente: 'hark', motivo: 'Alfie pasa a Extremadura' }, alfred, { now }); assert.equal(b.anterior, 'alfie');
  const z = await listarZonas(s, {}, lola); assert.deepEqual(z.porAgente, { hark: ['Madrid'] }); assert.equal(z.zonas[0].cambios, 1);
  const hilos = await listar(s, { tipo: 'asignacion' }, conchi); assert.equal(hilos.total, 2); assert.ok(hilos.hilos.every(h => h.estado === 'resuelto'));
  const sim = await reasignarFuentesZona(s, { zona: 'Madrid', agente: 'hark' }, alfred);
  assert.equal(sim.modo, 'simular'); assert.equal(sim.fuentesQueCambian, 2); assert.deepEqual(sim.responsableActual, { conchi: 1, alfie: 1 });
  const antes = s.writes.length; assert.equal(await code(reasignarFuentesZona(s, { zona: 'Madrid', agente: 'hark', modo: 'aplicar', codigoConfirmacion: 'falso' }, alfred)), 'board_confirmacion_invalida'); assert.equal(s.writes.length, antes);
  const ok = await reasignarFuentesZona(s, { zona: 'Madrid', agente: 'hark', modo: 'aplicar', codigoConfirmacion: sim.codigoConfirmacion, motivo: 'Reparto de Madrid' }, alfred, { now });
  assert.equal(ok.reasignadas, 2); assert.equal(ok.restantes, 0);
  const f = s.docs.get('registro_fuentes/fte_web_a1').data; assert.equal(f.responsable, 'hark'); assert.equal(f.modificada_por, 'alfred'); assert.equal(f.historial.at(-1).cambios[0].antes, 'conchi');
  assert.equal(s.docs.get('registro_fuentes/fte_web_a3').data.responsable, 'conchi'); assert.equal(s.docs.get('registro_fuentes/fte_web_a4').data.responsable, 'conchi'); // otra provincia y fusionada: intactas
  assert.equal((await reasignarFuentesZona(s, { zona: 'Madrid', agente: 'hark' }, alfred)).fuentesQueCambian, 0);
});
