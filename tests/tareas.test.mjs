import test from 'node:test';
import assert from 'node:assert/strict';
import { publicarTarea, actualizarTarea, listarTareas, misTareas, resumenTareas, AGENTES_CONOCIDOS } from '../tareas.mjs';
import { AGENTES } from '../identidad.mjs';

class Store {
  constructor() { this.docs = new Map(); this.writes = []; this.n = 1; }
  async get(c, id) { const r = this.docs.get(c + '/' + id); return r ? { id, data: structuredClone(r.data), updateTime: r.updateTime } : null; }
  async list(c, { cursor, limit = 500 } = {}) { return [...this.docs].filter(([k]) => k.startsWith(c + '/')).map(([, r]) => r).sort((a, b) => (a.id < b.id ? -1 : 1)).filter(r => !cursor || r.id > cursor).slice(0, limit).map(r => ({ id: r.id, data: structuredClone(r.data), updateTime: r.updateTime })); }
  async write(c, id, data, o = {}) {
    const k = c + '/' + id, cur = this.docs.get(k);
    if ((o.create && cur) || (!o.create && cur && o.updateTime !== cur.updateTime)) { const e = new Error('version_conflict'); e.code = 'version_conflict'; throw e; }
    this.writes.push({ c, id, create: !!o.create }); this.docs.set(k, { id, data: structuredClone(data), updateTime: String(++this.n) }); return {};
  }
}
const P = (id, actions) => ({ id, actions, businesses: ['*'] });
const alfred = P('alfred', ['read', 'board', 'board_admin']), alfredAltas = P('alfred-altas', ['read', 'board']), alfie = P('alfie', ['read', 'board']), conchi = P('conchi', ['read', 'board']), hark = P('hark', ['read', 'board']), panel = P('panel', ['board_read']), sin = P('ingesta', ['read', 'admit']);
let reloj = 0; const now = () => new Date(Date.UTC(2026, 10, 21, 10, 0, reloj++)).toISOString();
const code = p => p.then(() => null, e => e.code);

test('permisos: sin board no se publica ni lee; board_read solo lee; el agente sale del token', async () => {
  const s = new Store();
  assert.equal(await code(publicarTarea(s, { titulo: 'Revisar fuentes' }, sin)), 'forbidden');
  assert.equal(await code(publicarTarea(s, { titulo: 'Revisar fuentes' }, panel)), 'forbidden');
  assert.equal(await code(listarTareas(s, {}, sin)), 'forbidden');
  const t = await publicarTarea(s, { titulo: 'Revisar fuentes vencidas de Cáceres', estado: 'en_curso', agente: 'alfie' }, alfie, { now });
  assert.equal(t.agente, 'alfie'); assert.equal(t.estado, 'en_curso'); assert.equal(t.asignadaPor, null);
  assert.equal(await code(publicarTarea(s, { titulo: 'Tarea para Conchi', agente: 'conchi' }, alfie)), 'forbidden'); // solo Alfred reparte
  const a = await publicarTarea(s, { titulo: 'Revisar Soria', agente: 'conchi' }, alfred, { now }); assert.equal(a.agente, 'conchi'); assert.equal(a.asignadaPor, 'alfred'); assert.equal(a.estado, 'siguiente');
  assert.equal((await listarTareas(s, {}, panel)).total, 2);
});

test('validaciones y límites: título, estado inicial, máximo 5 en curso y 40 siguientes', async () => {
  const s = new Store(), x = P('limites', ['board']);
  assert.equal(await code(publicarTarea(s, { titulo: 'ab' }, x)), 'tarea_titulo_invalido');
  assert.equal(await code(publicarTarea(s, { titulo: 'Tarea ya hecha', estado: 'hecha' }, x)), 'tarea_estado_invalido');
  assert.equal(await code(publicarTarea(s, { titulo: 'Con refs malas', referencias: { fuenteIds: ['no válido!'] } }, x)), 'tarea_referencias_invalidas');
  for (let i = 0; i < 5; i++) await publicarTarea(s, { titulo: 'En curso ' + i, estado: 'en_curso' }, x, { now });
  assert.equal(await code(publicarTarea(s, { titulo: 'Sexta en curso', estado: 'en_curso' }, x)), 'tarea_limite_en_curso');
  for (let i = 0; i < 40; i++) await publicarTarea(s, { titulo: 'Siguiente ' + i }, x, { now });
  assert.equal(await code(publicarTarea(s, { titulo: 'Siguiente 41' }, x)), 'tarea_limite_siguientes');
});

test('ciclo de vida: siguiente → en curso (con progreso) → hecha; la terminada no se reabre; historial completo', async () => {
  const s = new Store(); const t = await publicarTarea(s, { titulo: 'Cargar zonas de Madrid', detalle: 'Antes de las 12' }, conchi, { now });
  assert.equal(t.estado, 'siguiente'); assert.equal(t.orden, 1);
  const u = await actualizarTarea(s, { tareaId: t.tareaId, estado: 'en_curso', progreso: 20, nota: 'Empiezo' }, conchi, { now }); assert.equal(u.estado, 'en_curso'); assert.ok(u.iniciadaEn);
  await actualizarTarea(s, { tareaId: t.tareaId, progreso: 70 }, conchi, { now });
  const h = await actualizarTarea(s, { tareaId: t.tareaId, estado: 'hecha' }, conchi, { now }); assert.equal(h.progreso, 100); assert.ok(h.terminadaEn);
  assert.equal(await code(actualizarTarea(s, { tareaId: t.tareaId, estado: 'en_curso' }, conchi)), 'tarea_transicion_invalida');
  const doc = s.docs.get('tareas_agentes/' + t.tareaId).data; assert.deepEqual(doc.historial.map(x => x.a), ['siguiente', 'en_curso', 'en_curso', 'hecha']); assert.equal(doc.historial[1].nota, 'Empiezo');
  assert.equal((await actualizarTarea(s, { tareaId: t.tareaId }, conchi)).actualizada, false);
  assert.equal(await code(actualizarTarea(s, { tareaId: t.tareaId, progreso: 101 }, conchi)), 'tarea_progreso_invalido');
  assert.equal(await code(actualizarTarea(s, { tareaId: 'tsk_inexistente' }, conchi)), 'tarea_no_encontrada');
});

test('bloqueo con motivo obligatorio; solo el dueño (o sus otros principales) o Alfred modifican', async () => {
  const s = new Store(); const t = await publicarTarea(s, { titulo: 'Esperar licencia del ayuntamiento', estado: 'en_curso' }, alfie, { now });
  assert.equal(await code(actualizarTarea(s, { tareaId: t.tareaId, estado: 'bloqueada' }, alfie)), 'tarea_motivo_bloqueo_requerido');
  const b = await actualizarTarea(s, { tareaId: t.tareaId, estado: 'bloqueada', motivoBloqueo: 'Espera respuesta de Alfred' }, alfie, { now }); assert.equal(b.motivoBloqueo, 'Espera respuesta de Alfred');
  assert.equal(await code(actualizarTarea(s, { tareaId: t.tareaId, estado: 'en_curso' }, hark)), 'forbidden');
  const r = await actualizarTarea(s, { tareaId: t.tareaId, estado: 'en_curso' }, alfred, { now }); assert.equal(r.motivoBloqueo, null);
  const mia = await publicarTarea(s, { titulo: 'Altas de Alfred' }, alfredAltas, { now }); assert.equal(mia.agente, 'alfred');
  assert.equal((await actualizarTarea(s, { tareaId: mia.tareaId, estado: 'en_curso' }, alfred, { now })).estado, 'en_curso');
});

test('listado: orden en curso, bloqueadas, siguientes por orden; hechas de los últimos 7 días; filtros', async () => {
  const s = new Store(), ahora = Date.UTC(2026, 10, 21, 12, 0, 0);
  const a = await publicarTarea(s, { titulo: 'Siguiente A' }, hark, { now }), b = await publicarTarea(s, { titulo: 'Siguiente B' }, hark, { now }), c = await publicarTarea(s, { titulo: 'En curso C', estado: 'en_curso' }, hark, { now });
  const d = await publicarTarea(s, { titulo: 'Hecha D', estado: 'en_curso' }, hark, { now }); await actualizarTarea(s, { tareaId: d.tareaId, estado: 'hecha' }, hark, { now: () => '2026-11-20T10:00:00.000Z' });
  const e = await publicarTarea(s, { titulo: 'Hecha vieja E', estado: 'en_curso' }, hark, { now }); await actualizarTarea(s, { tareaId: e.tareaId, estado: 'hecha' }, hark, { now: () => '2026-11-01T10:00:00.000Z' });
  await publicarTarea(s, { titulo: 'De Conchi' }, conchi, { now });
  const l = await listarTareas(s, { agente: 'hark' }, panel, { ahora }); assert.deepEqual(l.tareas.map(x => x.titulo), ['En curso C', 'Siguiente A', 'Siguiente B', 'Hecha D']);
  assert.equal((await listarTareas(s, { agente: 'hark', incluirTerminadas: true }, panel, { ahora })).total, 5);
  assert.equal((await listarTareas(s, { estado: 'activas' }, panel, { ahora })).total, 4);
  assert.equal((await misTareas(s, conchi, { ahora })).total, 1);
  void a; void b; void c;
});

test('resumen por agente: ahora, siguientes, bloqueadas y alertas (sin tareas, sin actualizar 24 h)', async () => {
  const s = new Store(), noodle = P('noodle', ['read', 'board']), ahora = Date.UTC(2026, 10, 21, 12, 0, 0), t0 = () => '2026-11-21T11:00:00.000Z', viejo = () => '2026-11-19T11:00:00.000Z';
  await publicarTarea(s, { titulo: 'Reparto de zonas', estado: 'en_curso' }, alfred, { now: t0 }); await publicarTarea(s, { titulo: 'Cargar zonas' }, alfred, { now: t0 });
  const c = await publicarTarea(s, { titulo: 'Revisar Soria', estado: 'en_curso' }, conchi, { now: viejo }); void c;
  const w = await publicarTarea(s, { titulo: 'Taller bloqueado', estado: 'en_curso' }, noodle, { now: t0 }); await actualizarTarea(s, { tareaId: w.tareaId, estado: 'bloqueada', motivoBloqueo: 'Falta licencia' }, noodle, { now: t0 });
  const r = await resumenTareas(s, panel, { ahora }); const por = Object.fromEntries(r.agentes.map(a => [a.agente, a]));
  assert.deepEqual(Object.keys(por).sort(), ['alfred', 'amalia', 'conchi', 'hark', 'lola', 'noodle', 'rene']);
  assert.equal(por.alfred.enCurso[0].titulo, 'Reparto de zonas'); assert.equal(por.alfred.totalSiguientes, 1); assert.equal(por.alfred.alerta, null);
  assert.equal(por.noodle.bloqueadas[0].motivo, 'Falta licencia'); assert.equal(por.conchi.alerta, 'sin_actualizar_24h'); assert.equal(por.conchi.horasSinActualizar, 49);
  assert.equal(por.hark.alerta, 'sin_tareas_publicadas'); assert.equal(por.amalia.ultimaActualizacion, null);
  assert.deepEqual(r.conAlerta.map(x => x.agente).sort(), ['amalia', 'conchi', 'hark', 'lola', 'rene']);
});

test('estadoPanel: en pausa con tanda programada; bloqueado solo si depende del propio agente', async () => {
  const s = new Store(), ahora = Date.UTC(2026, 10, 21, 11, 0, 0);
  const est = async () => Object.fromEntries((await resumenTareas(s, alfred, { ahora })).agentes.map(a => [a.agente, a.estadoPanel]));
  assert.equal((await est()).hark, 'sin_tareas');
  const sig = await publicarTarea(s, { titulo: 'Tanda de revisión de las 18:00' }, hark, { now });
  assert.equal((await est()).hark, 'en_pausa'); // nada en curso, sí una tanda programada
  await actualizarTarea(s, { tareaId: sig.tareaId, estado: 'en_curso' }, hark, { now });
  assert.equal((await est()).hark, 'en_curso');
  await actualizarTarea(s, { tareaId: sig.tareaId, estado: 'bloqueada', motivoBloqueo: 'Espero a que Alfred decida', esperaA: 'alfred' }, hark, { now });
  assert.equal((await est()).hark, 'en_pausa'); // espera a otra persona: no cuenta como bloqueado
  const propia = await publicarTarea(s, { titulo: 'Otra tarea', estado: 'en_curso' }, hark, { now });
  await actualizarTarea(s, { tareaId: propia.tareaId, estado: 'bloqueada', motivoBloqueo: 'Fallo mío al leer la fuente' }, hark, { now });
  assert.equal((await est()).hark, 'bloqueado');
  const r = (await resumenTareas(s, alfred, { ahora })).agentes.find(a => a.agente === 'hark');
  assert.equal(r.bloqueadas.find(b => b.esperaA).esperaA, 'alfred');
});

test('alfie dado de baja: no sale en resumen_tareas ni con alerta, pero sus tareas siguen guardadas y listables', async () => {
  const s = new Store(), ahora = Date.UTC(2026, 10, 24, 12, 0, 0), t0 = () => '2026-11-20T11:00:00.000Z';
  // Tareas históricas de alfie (en curso, siguiente y hecha) ya guardadas antes de la baja
  await publicarTarea(s, { titulo: 'Revisar Cáceres', estado: 'en_curso' }, alfie, { now: t0 }); await publicarTarea(s, { titulo: 'Tanda pendiente' }, alfie, { now: t0 });
  const h = await publicarTarea(s, { titulo: 'Fuentes de Toledo', estado: 'en_curso' }, alfie, { now: t0 }); await actualizarTarea(s, { tareaId: h.tareaId, estado: 'hecha' }, alfie, { now: t0 });
  assert.ok([...s.docs.values()].filter(r => r.data.agente === 'alfie').length >= 3);
  const r = await resumenTareas(s, panel, { ahora });
  assert.equal(r.agentes.some(a => a.agente === 'alfie'), false); assert.equal(r.conAlerta.some(a => a.agente === 'alfie'), false);
  assert.deepEqual(r.agentes.map(a => a.agente).sort(), ['alfred', 'amalia', 'conchi', 'hark', 'lola', 'noodle', 'rene']);
  const l = await listarTareas(s, { agente: 'alfie' }, alfred); assert.ok(l.total >= 3, 'el historial de tareas de alfie sigue consultable');
  assert.equal(AGENTES.includes('alfie'), false); assert.equal(AGENTES_CONOCIDOS.includes('alfie'), false);
});
