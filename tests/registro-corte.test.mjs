import test from 'node:test';
import assert from 'node:assert/strict';
import { registryCutoffConfig, REGISTRY_CUTOFF_DEFAULT, cutoffValue } from '../registro-provenance.mjs';
import { EventService } from '../event-service.mjs';
import { MemoryStore, owner, evento, procedencia, capturaLog } from './helpers/memoria.mjs';

test('corte del registro: opción > entorno > valor por defecto con aviso', () => {
  const avisos = [];
  assert.deepEqual(registryCutoffConfig('2026-11-01T00:00:00Z', undefined, m => avisos.push(m)), { cutoff: '2026-11-01T00:00:00Z', porDefecto: false });
  assert.deepEqual(registryCutoffConfig(undefined, ' 2026-11-10T00:00:00Z ', m => avisos.push(m)), { cutoff: '2026-11-10T00:00:00Z', porDefecto: false });
  assert.equal(avisos.length, 0);
  const d = registryCutoffConfig(undefined, undefined, m => avisos.push(m));
  assert.deepEqual(d, { cutoff: REGISTRY_CUTOFF_DEFAULT, porDefecto: true });
  assert.equal(avisos.length, 1); assert.match(avisos[0], /AMALIA_FUENTES_V2_DESDE_ISO/);
  registryCutoffConfig(undefined, '', m => avisos.push(m)); assert.equal(avisos.length, 1, 'el aviso sale una sola vez por proceso');
  assert.equal(cutoffValue(REGISTRY_CUTOFF_DEFAULT), REGISTRY_CUTOFF_DEFAULT);
});
test('un corte presente pero mal formado sigue siendo inválido (la admisión lo degrada, ver abajo)', () => {
  const c = registryCutoffConfig(undefined, 'mañana', () => {});
  assert.throws(() => cutoffValue(c.cutoff), /registro_cutoff_unconfigured/);
  assert.throws(() => cutoffValue(registryCutoffConfig('', undefined, () => {}).cutoff), /registro_cutoff_unconfigured/);
});

const svc = (store, cutoff) => new EventService(store, {}, { warm: false, registryCutoff: cutoff });
const admite = async (s, data, p = owner) => { const prep = await s.prepareAdmission(data, p); return { prep, r: await s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, p) }; };

for (const [titulo, corte] of [['env mal formado', 'mañana'], ['corte vacío', ''], ['corte en el futuro', '2999-01-01T00:00:00Z']]) {
  test(`${titulo}: el alta entra SIN procedencia, marcada procedenciaPendiente, con aviso en el log`, async () => {
    const store = new MemoryStore(), log = capturaLog();
    try {
      const { prep, r } = await admite(svc(store, corte), { ...evento(1), procedenciaRegistro: procedencia(store, 1) });
      assert.equal(prep.admisible, true); assert.equal(r.created, true);
      const d = store.rows.get('eventos/' + r.eventId).data;
      assert.equal(d.procedenciaPendiente, true); assert.equal(d.procedenciaRegistro, undefined);
      assert.match(d.procedenciaPendienteMotivo, /registro_cutoff_(unconfigured|not_reached)/);
      assert.equal(d.procedenciaPendienteDatos.fuenteId, d.fuentes && procedencia(store, 1).fuenteId);
      assert.ok(log.lineas.some(l => /procedencia_degradada/.test(l)), 'aviso en el log');
    } finally { log.restaurar(); }
  });
}
test('con datos falsos el alta SIGUE bloqueada aunque el corte no esté configurado', async () => {
  const store = new MemoryStore(), log = capturaLog();
  try {
    const s = svc(store, 'mañana');
    await assert.rejects(s.prepareAdmission({ ...evento(1), procedenciaRegistro: procedencia(store, 1, { urlPrimaria: 'https://www.editor.example/programacion/otra-cosa' }) }, owner), /registro_primary_mismatch/);
    await assert.rejects(s.prepareAdmission({ ...evento(1), procedenciaRegistro: procedencia(store, 1, { identificadorCanonico: 'otra.example/x' }) }, owner), /registro_source_identity_mismatch/);
    await assert.rejects(s.prepareAdmission({ ...evento(1), procedenciaRegistro: procedencia(store, 1, { fuenteId: 'fte_web_' + 'a'.repeat(24) }) }, owner), /registro_source_not_found/);
    await assert.rejects(s.prepareAdmission({ ...evento(1), procedenciaRegistro: { ...procedencia(store, 1), actorServidor: 'falso' } }, owner), /registro_provenance_invalid/);
    assert.equal(store.eventos().length, 0);
  } finally { log.restaurar(); }
});
test('reconciliar_procedencias adjunta la procedencia cuando el corte vuelve y deja pendiente lo que falla por datos', async () => {
  const store = new MemoryStore(), log = capturaLog();
  try {
    const roto = svc(store, 'mañana');
    const a = (await admite(roto, { ...evento(1), procedenciaRegistro: procedencia(store, 1) })).r, b = (await admite(roto, { ...evento(2), procedenciaRegistro: procedencia(store, 2) })).r;
    assert.deepEqual(await roto.reconciliarProcedencias({}, owner), { reconciliadas: 0, motivo: 'registro_cutoff_unconfigured', ayuda: (await roto.reconciliarProcedencias({}, owner)).ayuda });
    // la fuente cambió de versión (otra alta de la misma fuente) y sigue siendo válida: se reenlaza; la del evento b queda bloqueada por datos al pausar la fuente
    store.tocarFuente();
    const f = store.fuente(); store.rows.set('registro_fuentes/' + procedencia(store, 1).fuenteId, f);
    const bueno = svc(store, '2026-11-22T00:00:00Z');
    const sim = await bueno.reconciliarProcedencias({ simular: true }, owner);
    assert.equal(sim.reconciliadas, 2); assert.equal(store.rows.get('eventos/' + a.eventId).data.procedenciaPendiente, true, 'simular no escribe');
    const out = await bueno.reconciliarProcedencias({}, owner);
    assert.equal(out.reconciliadas, 2); assert.deepEqual(out.bloqueadasPorDatos, []);
    const da = store.rows.get('eventos/' + a.eventId).data;
    assert.equal(da.procedenciaPendiente, false); assert.equal(da.procedenciaRegistro.policy, 'authorized-editorial-registry-v1'); assert.equal(da.procedenciaRegistro.fuente.version, store.fuente().updateTime);
    assert.ok(da.procedenciaReconciliadaEn);
    assert.equal((await bueno.reconciliarProcedencias({}, owner)).revisadas, 0, 'idempotente: nada que hacer');
    // una fuente pausada = error de datos: el evento queda pendiente
    const c = (await admite(roto, { ...evento(3), procedenciaRegistro: procedencia(store, 3) })).r, fr = store.fuente(); await store.write('registro_fuentes', procedencia(store, 3).fuenteId, { ...fr.data, estado: 'pausada' }, { updateTime: fr.updateTime });
    const o3 = await bueno.reconciliarProcedencias({}, owner);
    assert.equal(o3.reconciliadas, 0); assert.equal(o3.bloqueadasPorDatos[0].error, 'registro_source_ineligible'); assert.equal(store.rows.get('eventos/' + c.eventId).data.procedenciaPendiente, true);
  } finally { log.restaurar(); }
});
