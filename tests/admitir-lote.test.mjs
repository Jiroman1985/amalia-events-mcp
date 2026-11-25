import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';
import { DomainError } from '../event-domain.mjs';
import { MemoryStore, owner, alfred, evento, procedencia, capturaLog } from './helpers/memoria.mjs';

const svc = (store, o = {}) => new EventService(store, {}, { warm: false, cola: true, registryCutoff: '2026-11-22T00:00:00Z', resolvePrincipal: id => ({ 'amalia-asistente': owner, alfred })[id] || null, ...o });
const preparar = async (s, n, extra = {}, p = owner) => { const prep = await s.prepareAdmission({ ...evento(n), ...extra }, p); return { prep, item: { evento: prep.evento, proposalHash: prep.proposalHash, huellaCampos: prep.huellaCampos } }; };

test('lote de 25 con 1 duplicado y 1 contención: entran 23, 1 omitido, 1 encolado; un fallo no tumba el lote', async () => {
  const store = new MemoryStore(), s = svc(store), log = capturaLog();
  try {
    const prep = [];
    for (let n = 1; n <= 25; n++) prep.push(await preparar(s, n));
    assert.ok(prep.every(x => x.prep.admisible));
    // otro agente da de alta lo mismo que el candidato 5 mientras tanto
    const dup = await s.prepareAdmission({ ...evento(5), sesionId: 'otra-ficha', requestId: 'otro-agente' }, alfred); await s.admitCandidate({ accion: 'admit', proposalHash: dup.proposalHash, evento: dup.evento }, alfred);
    // contención permanente sobre el candidato 10 (otro escritor gana siempre la guardia)
    const w = store.write.bind(store), id10 = prep[9].prep.eventId;
    store.write = async (c, id, ...r) => { if (c === 'eventos' && id === id10) throw new DomainError('version_conflict'); return w(c, id, ...r); };
    const out = await s.admitirLoteCandidatos({ items: prep.map(x => x.item) }, owner);
    assert.equal(out.total, 25); assert.equal(out.admitidos, 23); assert.equal(out.omitidos, 1); assert.equal(out.encolados, 1); assert.equal(out.errores, 0); assert.equal(out.pendientes, 0); assert.equal(out.completo, true);
    assert.equal(out.resultados[4].estado, 'omitido'); assert.match(out.resultados[4].motivo, /duplicate_event_conflict|session_key_conflict|requires_review/);
    assert.equal(out.resultados[9].estado, 'encolado'); assert.equal(out.resultados[9].motivo, 'admission_contended');
    assert.equal(store.eventos().length, 24, '23 del lote + el duplicado de otro agente');
    // repetir el lote no duplica nada: lo creado sale «ya_existia»; el encolado se reanuda solo cuando la contención cesa
    store.write = w;
    const otra = await s.admitirLoteCandidatos({ items: prep.map(x => x.item) }, owner);
    assert.equal(otra.admitidos, 1, 'el que estaba en contención entra ahora'); assert.equal(otra.omitidos, 24); assert.equal(store.eventos().length, 25);
    const cola = await s.reanudarCola({}, s.servidor); assert.equal(cola.reanudadas, 0); assert.equal(cola.omitidasDuplicado + cola.reanudadas + cola.rechazadas, 1, 'la entrada encolada se cierra sin duplicar'); assert.equal(store.eventos().length, 25);
  } finally { log.restaurar(); }
});

test('presupuesto de tiempo: devuelve los pendientes y repetirlos termina sin duplicar', async () => {
  const store = new MemoryStore(), s = svc(store), log = capturaLog();
  try {
    const items = []; for (let n = 1; n <= 6; n++) items.push((await preparar(s, n)).item);
    store.retardoMs = 25;
    const a = await s.admitirLoteCandidatos({ items }, owner, { presupuestoMs: 120 });
    assert.ok(a.pendientes > 0 && a.admitidos > 0 && a.completo === false); assert.match(a.aviso, /repite SOLO los pendientes/);
    store.retardoMs = 0;
    const b = await s.admitirLoteCandidatos({ items }, owner);
    assert.equal(b.pendientes, 0); assert.equal(store.eventos().length, 6); assert.equal(a.admitidos + b.admitidos, 6);
  } finally { log.restaurar(); }
});

test('represa en la misma llamada si solo cambió la versión de la fuente; con un campo distinto sigue rechazando', async () => {
  const store = new MemoryStore(), s = svc(store), log = capturaLog();
  try {
    const { prep } = await preparar(s, 1, { procedenciaRegistro: procedencia(store, 1) });
    store.tocarFuente(); // otra alta de la misma fuente movió la versión del documento
    const ok = await s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, owner);
    assert.equal(ok.created, true); assert.equal(ok.represado, true); assert.equal(ok.motivoRepresado, 'fuenteVersion'); assert.match(ok.proposalHashFinal, /^[a-f0-9]{64}$/); assert.notEqual(ok.proposalHashFinal, prep.proposalHash);
    assert.equal(ok.procedenciaRegistro.fuente.version, store.fuente().updateTime);
    // un campo cambiado entre preparar y admitir NO se represa
    const { prep: p2 } = await preparar(s, 2, { procedenciaRegistro: procedencia(store, 2) }); store.tocarFuente();
    await assert.rejects(s.admitCandidate({ accion: 'admit', proposalHash: p2.proposalHash, evento: { ...p2.evento, titulo: 'Otro título totalmente distinto' } }, owner), e => e.code === 'registro_source_changed');
    // sin represar explícito, el comportamiento anterior
    const { prep: p3 } = await preparar(s, 3, { procedenciaRegistro: procedencia(store, 3) }); store.tocarFuente();
    await assert.rejects(s.admitCandidate({ accion: 'admit', proposalHash: p3.proposalHash, evento: p3.evento }, owner, { represar: false }), e => e.code === 'registro_source_changed');
  } finally { log.restaurar(); }
});

test('represa por catálogo solo con huellaCampos idéntica y sin duplicado nuevo', async () => {
  const store = new MemoryStore(), s = svc(store), log = capturaLog();
  try {
    // existe un duplicado: la propuesta sale NO admisible y su hash incluye la coincidencia
    const base = await s.prepareAdmission({ ...evento(1), requestId: 'previo' }, alfred); const previo = await s.admitCandidate({ accion: 'admit', proposalHash: base.proposalHash, evento: base.evento }, alfred);
    const { prep } = await preparar(s, 1); assert.equal(prep.admisible, false);
    // el duplicado desaparece del catálogo (retirado/fusionado): ya no hay coincidencia → el hash recibido caduca
    store.rows.delete('eventos/' + previo.eventId); // el duplicado ya no está en el catálogo
    await assert.rejects(s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento }, owner), e => e.code === 'proposal_changed');
    const r = await s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento, huellaCampos: prep.huellaCampos }, owner);
    assert.equal(r.represado, true); assert.equal(r.motivoRepresado, 'catalogo'); assert.ok(r.proposalHashFinal);
    // con un campo cambiado la huella no coincide y no se represa
    const { prep: p2 } = await preparar(s, 2); const dup = { ...evento(2), requestId: 'dup2' }, pd = await s.prepareAdmission(dup, alfred); const creado = await s.admitCandidate({ accion: 'admit', proposalHash: pd.proposalHash, evento: pd.evento }, alfred);
    const { prep: p3 } = await preparar(s, 2, { requestId: 'req-2b' }); store.rows.delete('eventos/' + creado.eventId);
    await assert.rejects(s.admitCandidate({ accion: 'admit', proposalHash: p3.proposalHash, evento: { ...p3.evento, descripcion: 'Descripción cambiada después de preparar.' }, huellaCampos: p3.huellaCampos }, owner), e => e.code === 'proposal_changed');
    void p2;
  } finally { log.restaurar(); }
});
