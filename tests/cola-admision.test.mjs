import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';
import { MemoryStore, owner, alfred, evento, procedencia, capturaLog } from './helpers/memoria.mjs';

const PRINCIPALES = { 'amalia-asistente': owner, alfred };
const svc = (store, o = {}) => new EventService(store, {}, { warm: false, cola: true, registryCutoff: '2026-11-22T00:00:00Z', resolvePrincipal: id => PRINCIPALES[id] || null, ...o });
// El agente: prepara y admite como en producción (conCola es lo que envuelven las herramientas).
async function altaComoAgente(s, data, p = owner) {
  const prep = await s.conCola('preparar', data, p, () => s.prepareAdmission(data, p));
  if (prep.encolado) return prep;
  return s.conCola('admitir', prep.evento, p, () => s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, p));
}
const cola = store => [...store.rows].filter(([k]) => k.startsWith('cola_admision/')).map(([k, r]) => ({ id: k.slice(14), ...r.data }));
const avisos = store => [...store.rows].filter(([k]) => k.startsWith('tablon_agentes/')).map(([, r]) => r.data);

test('admission_paused: el candidato se encola, reanudar no hace nada en rojo y al reabrir admite UNA vez aunque se ejecute dos veces', async () => {
  const store = new MemoryStore(), s = svc(store), log = capturaLog();
  try {
    const prep = await s.prepareAdmission(evento(1), owner);
    store.pausar(true);
    const r = await s.conCola('admitir', prep.evento, owner, () => s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, owner));
    assert.equal(r.encolado, true); assert.equal(r.motivo, 'admission_paused'); assert.match(r.ayuda, /NO esperes aviso/);
    assert.equal(store.eventos().length, 0); assert.equal(cola(store).length, 1); assert.equal(cola(store)[0].estado, 'pendiente'); assert.equal(cola(store)[0].requestId, 'req-1');
    // el mismo candidato otra vez: no se duplica la entrada
    const otra = await s.conCola('admitir', prep.evento, owner, () => s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, owner));
    assert.equal(otra.colaId, r.colaId); assert.equal(cola(store).length, 1);
    // en rojo (pausa) no se reanuda
    const rojo = await s.reanudarCola({}, alfred); assert.equal(rojo.reanudadas, 0); assert.equal(rojo.motivo, 'salud_no_operativa');
    store.pausar(false);
    const [a, b] = await Promise.all([s.reanudarCola({}, s.servidor), s.reanudarCola({}, s.servidor)]);
    assert.equal(a.reanudadas + b.reanudadas, 1, 'una sola ejecución concurrente reanuda'); assert.ok([a, b].some(x => x.motivo === 'ya_en_curso'));
    assert.equal(store.eventos().length, 1); assert.equal(cola(store)[0].estado, 'reanudada'); assert.equal(cola(store)[0].eventId, store.eventos()[0].id);
    const otraVez = await s.reanudarCola({}, s.servidor); assert.equal(otraVez.revisadas, 0); assert.equal(store.eventos().length, 1);
    // nota en el tablón para el agente afectado y para Alfred
    const notas = avisos(store); assert.equal(notas.length, 1); assert.deepEqual([...notas[0].destinatarios].sort(), ['alfred', 'amalia']); assert.match(notas[0].texto, /1 admitidas/);
  } finally { log.restaurar(); }
});

test('catalog_guard_unavailable y operation_timeout también se encolan; un error de datos NO', async () => {
  const store = new MemoryStore(), s = svc(store, { plazoLlamadaMs: 60 }), log = capturaLog();
  try {
    store.quitarGuardia();
    const a = await altaComoAgente(s, evento(1)); assert.equal(a.encolado, true); assert.equal(a.motivo, 'catalog_guard_unavailable'); assert.equal(a.admisible, false);
    store.ponerGuardia(); store.retardoMs = 200;
    const b = await altaComoAgente(s, evento(2)); assert.equal(b.encolado, true); assert.equal(b.motivo, 'operation_timeout');
    store.retardoMs = 0;
    await assert.rejects(altaComoAgente(s, { ...evento(3), fechaLocal: 'no-es-fecha' }), e => !e.code?.startsWith('operation_timeout'));
    assert.equal(cola(store).length, 2);
    const err = s.monitor.erroresDesde(2 * 3600 * 1000); assert.equal(err.catalog_guard_unavailable, 1); assert.equal(err.operation_timeout, 1);
    // el candidato de la cola, ya sano, se admite sin duplicar (el timeout dejó en marcha la preparación original)
    const out = await s.reanudarCola({ limite: 10 }, s.servidor); assert.equal(out.reanudadas, 2); assert.equal(store.eventos().length, 2);
  } finally { log.restaurar(); }
});

test('la cola respeta el escaneo de duplicados: un duplicado nuevo se omite y se avisa', async () => {
  const store = new MemoryStore(), s = svc(store), log = capturaLog();
  try {
    store.pausar(true);
    const prep = await s.prepareAdmission(evento(1), owner);
    await s.conCola('admitir', prep.evento, owner, () => s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, owner));
    store.pausar(false);
    // mientras tanto otro agente da de alta lo mismo (otra requestId)
    const dup = { ...evento(1), requestId: 'otro-agente' }, pd = await s.prepareAdmission(dup, alfred); await s.admitCandidate({ accion: 'admit', proposalHash: pd.proposalHash, evento: pd.evento }, alfred);
    const out = await s.reanudarCola({}, s.servidor);
    assert.equal(out.reanudadas, 0); assert.equal(out.omitidasDuplicado, 1); assert.equal(store.eventos().length, 1); assert.equal(cola(store)[0].estado, 'omitida_duplicado');
  } finally { log.restaurar(); }
});

test('cada agente solo ve y reanuda lo suyo; Alfred todo; salud_admision informa cola, cutoff y errores', async () => {
  const store = new MemoryStore(), s = svc(store), log = capturaLog();
  try {
    store.pausar(true);
    for (const [n, p] of [[1, owner], [2, alfred]]) { const pr = await s.prepareAdmission(evento(n), p); await s.conCola('admitir', pr.evento, p, () => s.admitCandidate({ accion: 'admit', proposalHash: pr.proposalHash, evento: pr.evento }, p)); }
    assert.equal((await s.listarCola({}, owner)).total, 1); assert.equal((await s.listarCola({}, alfred)).total, 2);
    const h = await s.salud(owner);
    assert.equal(h.operativa, false); assert.equal(h.estado, 'rojo'); assert.equal(h.dependencias.guardiaCatalogo.admissionPaused, true); assert.equal(h.dependencias.cutoff.configurado, true);
    assert.equal(h.cola.pendientes, 2); assert.deepEqual(Object.keys(h.cola.porAgente).sort(), ['alfred', 'amalia']); assert.equal(h.erroresPlataforma2h.admission_paused, 2);
    store.pausar(false);
    const mia = await s.reanudarCola({}, owner); assert.equal(mia.reanudadas, 1); assert.equal((await s.listarCola({}, alfred)).total, 1);
    const v = await s.salud(owner); assert.equal(v.operativa, true); assert.equal(v.estado, 'amarillo', 'amarillo mientras haya cola o errores recientes');
    assert.equal(s.registryOptions.porDefecto === true, false);
    const mal = svc(store, { registryCutoff: 'mañana' }), hm = await mal.salud(owner);
    assert.equal(hm.dependencias.cutoff.configurado, false); assert.match(hm.dependencias.cutoff.efecto, /procedenciaPendiente/);
  } finally { log.restaurar(); }
});
