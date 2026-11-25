import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';
import { MonitorPlataforma } from '../plataforma.mjs';
import { objetivos } from '../ritmo.mjs';
import { publicarTarea } from '../tareas.mjs';
import { MemoryStore, owner, alfred, evento, capturaLog } from './helpers/memoria.mjs';

const HORA = 3600 * 1000;
const montar = () => { const reloj = { t: Date.now() }, store = new MemoryStore(), monitor = new MonitorPlataforma({ ahora: () => reloj.t }); return { reloj, store, s: new EventService(store, {}, { warm: false, cola: true, monitor, registryCutoff: '2026-11-22T00:00:00Z', resolvePrincipal: id => ({ 'amalia-asistente': owner, alfred })[id] || null }) }; };
const alta = async (s, n, p = owner) => { const prep = await s.prepareAdmission(evento(n), p); return s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, p); };
// El almacén de prueba no tiene consulta indexada: se usa la caché del catálogo, que hay que invalidar al reescribir la fecha a mano.
const envejecer = (s, store, eventId, ms) => { store.rows.get('eventos/' + eventId).data.fechaCreacion = new Date(Date.now() - ms).toISOString(); s.universeCache = null; };
const alertas = store => [...store.rows].filter(([k]) => k.startsWith('tablon_agentes/')).map(([, r]) => r.data).filter(d => d.alerta_auto === true);

test('ritmo_altas cuenta la última hora y 24 h contra el objetivo de AMALia', async () => {
  const { s, store } = montar(), log = capturaLog();
  try {
    const a = await alta(s, 1), b = await alta(s, 2), c = await alta(s, 3);
    envejecer(s, store, b.eventId, 5 * HORA); envejecer(s, store, c.eventId, 30 * HORA); void a;
    const r = await s.ritmoAltas(owner), am = r.agentes.find(x => x.agente === 'amalia');
    assert.equal(am.altasUltimaHora, 1); assert.equal(am.altasUltimas24h, 2, 'la de hace 30 h queda fuera'); assert.deepEqual(am.objetivo, { minimoDia: 100, maximoDia: 200, porHoraEfectiva: 10 });
    assert.equal(am.estado, 'por_debajo'); assert.equal(am.avanceMinimoDiaPct, 2); assert.equal(am.colaPendiente.pendientes, 0);
  } finally { log.restaurar(); }
});

test('alerta a Alfred a las 2 h sin altas (con tareas en curso) y se cierra sola al haber un alta; nunca duplicada', async () => {
  const { s, store } = montar(), log = capturaLog();
  try {
    const a = await alta(s, 1); envejecer(s, store, a.eventId, 1.8 * HORA);
    await publicarTarea(store, { titulo: 'Altas de Andalucía', estado: 'en_curso' }, owner);
    assert.equal((await s.vigilar()).abiertas.length, 0, 'a 1 h 48 min todavía no');
    envejecer(s, store, a.eventId, 2.2 * HORA);
    const v = await s.vigilar(); assert.equal(v.abiertas.length, 1); assert.equal(v.abiertas[0].clave, 'ritmo:amalia');
    const [al] = alertas(store); assert.equal(al.tipo, 'ayuda'); assert.equal(al.prioridad, 'urgente'); assert.deepEqual(al.destinatarios, ['alfred']); assert.equal(al.estado, 'abierto'); assert.equal(al.requiere_atencion, true); assert.equal(al.espera_a, undefined); assert.match(al.asunto, /amalia lleva 2 h sin altas/);
    assert.equal((await s.vigilar()).abiertas.length, 0, 'una sola alerta abierta por agente y asunto'); assert.equal(alertas(store).filter(x => x.estado === 'abierto').length, 1);
    await alta(s, 2); // el agente reanuda
    const cierre = await s.vigilar(); assert.deepEqual(cierre.cerradas.map(x => x.clave), ['ritmo:amalia']);
    const [cerrada] = alertas(store); assert.equal(cerrada.estado, 'resuelto'); assert.equal(cerrada.requiere_atencion, false); assert.equal(cerrada.resuelto_por, 'sistema');
  } finally { log.restaurar(); }
});

test('sin cola ni tareas en curso no hay alerta aunque no haya altas; con cola pendiente sí', async () => {
  const { s, store } = montar(), log = capturaLog();
  try {
    assert.equal((await s.vigilar()).abiertas.length, 0);
    store.pausar(true); const prep = await s.prepareAdmission(evento(1), owner);
    await s.conCola('admitir', prep.evento, owner, () => s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, owner));
    const v = await s.vigilar(); assert.deepEqual(v.abiertas.map(x => x.clave), ['ritmo:amalia']);
    assert.match(alertas(store)[0].texto, /Cola de admisión pendiente: 1 \(admission_paused 1\)/);
  } finally { log.restaurar(); }
});

test('el mismo error de plataforma 3 veces en 15 min abre una alerta (esperaA inaki) y se cierra sola', async () => {
  const { s, store, reloj } = montar(), log = capturaLog();
  try {
    store.pausar(true);
    const falla = async n => { const prep = await s.prepareAdmission(evento(n), owner); return s.conCola('admitir', prep.evento, owner, () => s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, owner)); };
    await falla(1); reloj.t += 60000; await falla(2);
    assert.equal((await s.vigilar()).abiertas.filter(x => x.clave.startsWith('error:')).length, 0, 'con 2 errores no hay alerta');
    reloj.t += 60000; await falla(3);
    const v = await s.vigilar(); assert.ok(v.abiertas.some(x => x.clave === 'error:amalia:admission_paused'));
    const al = alertas(store).find(x => x.alerta_clave === 'error:amalia:admission_paused'); assert.equal(al.espera_a, 'inaki'); assert.deepEqual(al.destinatarios, ['alfred']); assert.equal(al.requiere_atencion, true);
    assert.equal((await s.vigilar()).abiertas.filter(x => x.clave.startsWith('error:')).length, 0, 'no se duplica');
    reloj.t += 16 * 60000; // el error deja de repetirse
    const cierre = await s.vigilar(); assert.ok(cierre.cerradas.some(x => x.clave === 'error:amalia:admission_paused'));
    assert.equal(alertas(store).find(x => x.alerta_clave === 'error:amalia:admission_paused').estado, 'resuelto');
  } finally { log.restaurar(); }
});

test('objetivos: por defecto AMALia 100-200; una variable inválida vuelve al defecto con aviso', () => {
  const avisos = [];
  assert.deepEqual(objetivos(undefined, m => avisos.push(m)).amalia, { min: 100, max: 200, horasEfectivas: 10 });
  assert.equal(objetivos('{"hark":{"min":10,"max":20}}', m => avisos.push(m)).hark.horasEfectivas, 10);
  assert.equal(avisos.length, 0);
  assert.deepEqual(objetivos('esto no es json', m => avisos.push(m)).amalia.min, 100); assert.equal(avisos.length, 1);
  objetivos('{"amalia":{"min":50,"max":10}}', m => avisos.push(m)); assert.equal(avisos.length, 2);
});
