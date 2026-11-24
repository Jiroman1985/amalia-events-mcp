import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';
import { conPlazo, DomainError } from '../event-domain.mjs';
import { readRegistry } from '../registro-fuentes.mjs';
import { planificarIdentidades } from '../migracion-identidades.mjs';
import { FirestoreStore } from '../firestore-store.mjs';

const owner = { id: 'alfie', actions: ['*'], businesses: ['*'], agente: 'alfie' };
class MemoryStore {
  constructor() { this.rows = new Map([['negocios/b', { data: { nombre: 'N' }, updateTime: '1' }], ['amalia_catalog_guard/eventos', { data: { epoch: 1 }, updateTime: 'g1' }]]); this.seq = 1; this.writes = []; }
  async get(c, id) { const r = this.rows.get(c + '/' + id); return r ? { id, ...structuredClone(r) } : null; }
  async list(c) { return [...this.rows].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.split('/').at(-1), ...structuredClone(r) })).sort((a, b) => (a.id < b.id ? -1 : 1)); }
  async write(c, id, data, o = {}) {
    const key = c + '/' + id, cur = this.rows.get(key);
    if ((o.create && cur) || (!o.create && cur && o.updateTime !== cur.updateTime)) throw new DomainError('version_conflict');
    const next = o.updateFields && cur ? { ...cur.data, ...data } : structuredClone(data);
    this.rows.set(key, { data: next, updateTime: 'u' + (++this.seq) }); this.writes.push({ c, id });
    if (o.request) this.rows.set('amalia_event_requests/' + o.request.id, { data: o.request.data, updateTime: 'u' + this.seq });
    if (o.reserve) this.rows.set('amalia_event_reservations/' + o.reserve.id, { data: o.reserve.data, updateTime: 'u' + this.seq });
    if (c === 'eventos') this.rows.set('amalia_catalog_guard/eventos', { data: { epoch: this.seq }, updateTime: 'g' + this.seq });
    return { id, updateTime: 'u' + this.seq };
  }
  async revisions() { return []; }
}
const base = (o = {}) => ({ negocioId: 'b', titulo: 'Concierto de Navidad en Casatejada', descripcion: 'Ciclo de conciertos.', city: 'Casatejada', provincia: 'Provincia de prueba', timeZone: 'Europe/Madrid', fuentes: [{ url: 'https://example.org/casatejada', checkedAt: '2026-11-20T10:00:00Z' }], prueba: true, verificationStatus: 'capturado', requestId: 'cand_b78231d9', ...o });
const sesiones = n => Array.from({ length: n }, (_, i) => ({ fechaLocal: `2099-12-${String(i + 1).padStart(2, '0')}`, horaLocal: '20:00' }));
const svc = () => new EventService(new MemoryStore(), { get: () => { throw Error('sin imagen'); } }, { warm: false });

test('conPlazo: devuelve el resultado a tiempo y un error claro si vence', async () => {
  assert.equal(await conPlazo(Promise.resolve(7), 50), 7);
  await assert.rejects(conPlazo(new Promise(() => {}), 20, 'operation_timeout'), e => e.code === 'operation_timeout' && /Reintenta/.test(e.details.ayuda));
});

test('una carga del catálogo colgada se abandona con error claro y la siguiente llamada se recupera', async () => {
  process.env.AMALIA_UNIVERSE_LOAD_MS = '40';
  const mod = await import('../event-service.mjs?lento');
  let colgar = true;
  const store = { async get(c) { return c === 'amalia_catalog_guard' ? { id: 'eventos', data: { epoch: 1 }, updateTime: 'g1' } : null; }, async listAll(c) { if (colgar) return new Promise(() => {}); return []; } };
  const ev = new mod.EventService(store, {}, { warm: false });
  await assert.rejects(ev.catalogUniverse(), e => e.code === 'catalog_load_timeout');
  colgar = false;
  const u = await ev.catalogUniverse(); assert.deepEqual(u.docs, []);
  delete process.env.AMALIA_UNIVERSE_LOAD_MS;
});

test('readRegistry: reutiliza la lectura, devuelve copias y se invalida con una escritura propia', async () => {
  let lecturas = 0; const docs = [{ id: 'f1', data: { a: 1 }, updateTime: '1' }];
  const store = { async listAll() { lecturas++; return structuredClone(docs); }, async write() { return {}; } };
  const a = await readRegistry(store); a[0].data.a = 99;
  const b = await readRegistry(store); assert.equal(lecturas, 1); assert.equal(b[0].data.a, 1);
  await store.write('registro_fuentes', 'f1', {}); await readRegistry(store); assert.equal(lecturas, 2);
  await store.write('eventos', 'x', {}); await readRegistry(store); assert.equal(lecturas, 2);
});

test('varias sesiones en una llamada: se comprueban una a una y se crean todas con un solo hash', async () => {
  const ev = svc(), input = base({ temporalidad: { tipo: 'sesiones', sesiones: sesiones(3) } });
  const p = await ev.prepareAdmission(input, owner);
  assert.equal(p.multiple, true); assert.equal(p.sesionesTotal, 3); assert.equal(p.admisibles, 3); assert.equal(p.bloqueadas, 0);
  assert.deepEqual(p.sesiones.map(s => s.fechaLocal), ['2099-12-01', '2099-12-02', '2099-12-03']);
  const r = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: input }, owner);
  assert.equal(r.creadas, 3); assert.equal(r.completo, true); assert.equal(new Set(r.resultados.map(x => x.eventId)).size, 3);
  const otra = await ev.admitCandidate({ accion: 'admit', proposalHash: (await ev.prepareAdmission(input, owner)).proposalHash, evento: input }, owner).catch(e => e);
  assert.ok(otra.multiple ? otra.yaExistian === 3 || otra.omitidas >= 0 : otra instanceof Error);
});

test('lote: una sesión duplicada se omite con su motivo y las demás se crean; hash obsoleto y límites', async () => {
  const ev = svc(), una = base({ temporalidad: { tipo: 'sesiones', sesiones: [sesiones(2)[1]] }, requestId: 'previa' });
  const p1 = await ev.prepareAdmission(una, owner); await ev.admitCandidate({ accion: 'admit', proposalHash: p1.proposalHash, evento: una }, owner);
  const lote = base({ temporalidad: { tipo: 'sesiones', sesiones: sesiones(3) }, requestId: 'lote' });
  const p = await ev.prepareAdmission(lote, owner);
  assert.equal(p.admisibles, 2); assert.equal(p.bloqueadas, 1); assert.equal(p.sesiones.find(s => !s.admisible).fechaLocal, '2099-12-02');
  await assert.rejects(ev.admitCandidate({ accion: 'admit', proposalHash: 'a'.repeat(64), evento: lote }, owner), e => e.code === 'proposal_changed');
  const r = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: lote }, owner);
  assert.equal(r.creadas, 2); assert.equal(r.omitidas, 1); assert.equal(r.resultados.find(x => x.estado === 'omitida_duplicado').fechaLocal, '2099-12-02');
  await assert.rejects(ev.prepareAdmission(base({ temporalidad: { tipo: 'sesiones', sesiones: sesiones(61) } }), owner), e => e.code === 'too_many_sessions');
  await assert.rejects(ev.prepareAdmission(base({ temporalidad: { tipo: 'sesiones', sesiones: [sesiones(1)[0], sesiones(1)[0]] } }), owner), e => e.code === 'duplicate_sessions_in_call');
});

test('identidad canónica al escribir eventos: updatedBy/retiradoPor/actor canónicos con el principal original aparte', async () => {
  const ev = svc(), alias = { id: 'alfred-altas', actions: ['*'], businesses: ['*'], agente: 'alfred' };
  const e = base({ temporalidad: { tipo: 'sesiones', sesiones: sesiones(1) } });
  const p = await ev.prepareAdmission(e, alias); const c = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: e }, alias);
  const doc = ev.store.rows.get('eventos/' + c.eventId).data;
  assert.equal(doc.agenteCanonico, 'alfred'); assert.equal(doc.updatedBy, 'alfred'); assert.equal(doc.updatedByPrincipal, 'alfred-altas'); assert.equal(doc.createdBy, 'alfred-altas');
  const v = await ev.retirePreview({ eventId: c.eventId, negocioId: 'b' }, alias);
  const r = await ev.retire({ eventId: c.eventId, negocioId: 'b', expectedVersion: v.versionActual, motivo: 'Duplicado', codigoConfirmacion: v.codigoConfirmacion }, alias);
  assert.equal(r.retiradoPor, 'alfred'); assert.equal(r.retiradoPorPrincipal, 'alfred-altas'); assert.equal(r.updatedBy, 'alfred');
  const pv = await ev.restorePreview({ eventId: c.eventId, negocioId: 'b' }, alias); assert.equal(pv.versionActual, r.version);
  const back = await ev.restore({ eventId: c.eventId, negocioId: 'b', expectedVersion: r.version, motivo: 'Error' }, alias); assert.equal(back.recuperadoPor, 'alfred'); assert.equal(back.recuperadoPorPrincipal, 'alfred-altas');
  assert.equal(await ev.restorePreview({ eventId: c.eventId, negocioId: 'b' }, alias).catch(e => e.code), 'not_retired');
});

test('migración de identidades en eventos (ensayo): añade agenteCanonico y canoniza updatedBy/retiradoPor sin tocar createdBy', () => {
  const rows = [
    { id: 'e1', updateTime: '1', data: { createdBy: 'amalia-asistente', updatedBy: 'amalia-asistente' } },
    { id: 'e2', updateTime: '1', data: { createdBy: 'alfie', agenteCanonico: 'alfie', retiradoPor: 'alfred-altas', updatedBy: 'alfred-altas' } },
    { id: 'e3', updateTime: '1', data: { createdBy: 'alfie', agenteCanonico: 'alfie', updatedBy: 'alfie' } },
    { id: 'e4', updateTime: '1', data: { createdBy: 'claude-ingesta', updatedBy: 'alfred-altas', retiradoPorPrincipal: 'x', retiradoPor: 'alfred-ediciones' } }
  ];
  const { informe, cambios } = planificarIdentidades({ eventos: rows });
  assert.equal(cambios.length, 3); const por = Object.fromEntries(cambios.map(c => [c.id, c.set]));
  assert.deepEqual(por.e1, { agenteCanonico: 'amalia', updatedBy: 'amalia', updatedByPrincipal: 'amalia-asistente' });
  assert.deepEqual(por.e2, { retiradoPor: 'alfred', retiradoPorPrincipal: 'alfred-altas', updatedBy: 'alfred', updatedByPrincipal: 'alfred-altas' });
  assert.deepEqual(por.e4, { updatedBy: 'alfred', updatedByPrincipal: 'alfred-altas', retiradoPor: 'alfred' });
  assert.ok(!cambios.some(c => 'createdBy' in c.set)); assert.equal(informe.eventos.retiradoPor, 2);
});

test('metadataOnly admite los campos de identidad de eventos y nada más', async () => {
  const st = new FirestoreStore({ project: 'p', key: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const code = p => p.then(() => null, e => e.code);
  assert.equal(await code(st.write('eventos', 'e', { titulo: 'x' }, { updateFields: ['updatedBy', 'titulo'], updateTime: '1', metadataOnly: true })), 'metadata_write_forbidden');
});

const CAMPAMENTO = [
  { fechaLocal: '2026-12-28', horaLocal: '09:30', horaFinLocal: '13:30' }, { fechaLocal: '2026-12-29', horaLocal: '09:30', horaFinLocal: '13:30' },
  { fechaLocal: '2026-12-30', horaLocal: '09:30', horaFinLocal: '13:30' }, { fechaLocal: '2027-01-04', horaLocal: '09:30', horaFinLocal: '13:30' }, { fechaLocal: '2027-01-05', horaLocal: '09:30', horaFinLocal: '13:30' }
];
const campamento = (o = {}) => base({ titulo: 'Campamento de Navidad — AMPA José Pavón', city: 'Casatejada', sesionId: 'campamento-navidad-20261228-20270105', requestId: 'alfie-adm-f4e71866', temporalidad: { tipo: 'sesiones', sesiones: CAMPAMENTO, textoOriginal: '28, 29 y 30 de diciembre y 4 y 5 de enero, de 9:30 a 13:30.' }, ...o });

test('Casatejada: con sesionId estable las 5 sesiones se guardan en UNA ficha (primera fecha, fin = última, lista completa)', async () => {
  const ev = svc(), input = campamento();
  const p = await ev.prepareAdmission(input, owner);
  assert.notEqual(p.multiple, true); assert.equal(p.admisible, true);
  assert.equal(p.candidato.fechaLocal, '2026-12-28'); assert.equal(p.candidato.fechaFinLocal, '2027-01-05'); assert.equal(p.candidato.sesiones.length, 5);
  const r = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: input }, owner);
  const doc = ev.store.rows.get('eventos/' + r.eventId).data;
  assert.deepEqual(doc.sesiones.map(s => s.fechaLocal), ['2026-12-28', '2026-12-29', '2026-12-30', '2027-01-04', '2027-01-05']);
  assert.ok(doc.sesiones.every(s => s.horaLocal === '09:30' && s.horaFinLocal === '13:30'));
  assert.equal(doc.fechaFinLocal, '2027-01-05'); assert.equal(doc.temporalidadTipo, 'sesiones'); assert.match(doc.temporalidadTexto, /9:30 a 13:30/);
  assert.equal([...ev.store.rows.keys()].filter(k => k.startsWith('eventos/')).length, 1);
  // Repetir la alta no crea otra ficha.
  const again = await ev.prepareAdmission(input, owner).then(q => ev.admitCandidate({ accion: 'admit', proposalHash: q.proposalHash, evento: input }, owner)).catch(e => e);
  assert.equal([...ev.store.rows.keys()].filter(k => k.startsWith('eventos/')).length, 1); assert.ok(again.alreadyCreated || again instanceof Error);
});

test('Casatejada: una sesión adicional que choca con otro evento bloquea la ficha (comprobación sesión a sesión)', async () => {
  const ev = svc();
  const otro = base({ titulo: 'Campamento de Navidad — AMPA José Pavón', sesionId: 'otra-carga', requestId: 'previa', temporalidad: { tipo: 'sesiones', sesiones: [{ fechaLocal: '2026-12-30', horaLocal: '09:30' }] }, lugar: undefined });
  const p0 = await ev.prepareAdmission(otro, owner); await ev.admitCandidate({ accion: 'admit', proposalHash: p0.proposalHash, evento: otro }, owner);
  const p = await ev.prepareAdmission(campamento({ fuentes: [{ url: 'https://example.org/otra-fuente', checkedAt: '2026-11-20T10:00:00Z' }] }), owner);
  assert.equal(p.admisible, false); assert.ok(p.coincidencias.some(c => c.sesion === '2026-12-30'));
});

test('repara una ficha ya creada con una sola sesión: añade las sesiones sin crear otra ficha', async () => {
  const ev = svc();
  const una = campamento({ temporalidad: { tipo: 'sesiones', sesiones: [CAMPAMENTO[0]], textoOriginal: '28, 29 y 30 de diciembre y 4 y 5 de enero, de 9:30 a 13:30.' } });
  const p = await ev.prepareAdmission(una, owner); const c = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: una }, owner);
  assert.equal(ev.store.rows.get('eventos/' + c.eventId).data.sesiones, undefined);
  const out = await ev.update({ eventId: c.eventId, negocioId: 'b', expectedVersion: 1, changes: { sesiones: CAMPAMENTO, fechaFinLocal: '2027-01-05' }, reason: 'Completar las sesiones del campamento (29/12, 30/12, 4/1 y 5/1)', evidenciaUrl: 'https://example.org/casatejada' }, { id: 'alfred-altas', actions: ['*'], businesses: ['*'], agente: 'alfred' });
  const doc = ev.store.rows.get('eventos/' + c.eventId).data;
  assert.equal(doc.sesiones.length, 5); assert.equal(doc.fechaFinLocal, '2027-01-05'); assert.equal(doc.version, 2); assert.equal(out.version, 2); assert.equal(doc.updatedBy, 'alfred');
  assert.equal([...ev.store.rows.keys()].filter(k => k.startsWith('eventos/')).length, 1);
});

test('sin sesionId ni origen, varias sesiones en un alta directa siguen pidiendo una llamada por sesión o el lote', async () => {
  const { canonicalInput } = await import('../event-domain.mjs');
  assert.throws(() => canonicalInput(base({ temporalidad: { tipo: 'sesiones', sesiones: CAMPAMENTO } })), /multiple_sessions_split_calls/);
});

test('rellenar url_normalizada ausente en Instagram: solo las coherentes, las demás se informan', async () => {
  const { planRelleno } = await import('../reparacion-url.mjs');
  const mk = (id, d) => ({ id, data: { canal: 'instagram', ...d } });
  const plan = planRelleno([
    mk('a', { identificador: 'AytoX', url: 'https://www.instagram.com/aytox/' }),         
    mk('b', { identificador: 'ayto_y', url: 'https://www.instagram.com/ayto_y/', codigo: 'F-1' }),
    mk('c', { identificador: 'ok', url: 'https://www.instagram.com/ok/', url_normalizada: 'instagram.com/ok' }),
    mk('d', { identificador: 'raro', url: 'https://x.es/raro' }),
    { id: 'e', data: { canal: 'web', url: 'https://x.es' } }
  ]);
  assert.deepEqual(plan.items.map(i => [i.fuenteId, i.valor]), [['a', 'instagram.com/aytox'], ['b', 'instagram.com/ayto_y']]);
  assert.deepEqual(plan.omitidas.map(o => o.fuenteId), ['d']); assert.equal(plan.total, 2);
});

test('editar_evento con simular=true valida y muestra los cambios sin escribir; sin simular aplica', async () => {
  const ev = svc(), una = base({ temporalidad: { tipo: 'sesiones', sesiones: [{ fechaLocal: '2099-03-01', horaLocal: '10:00' }] }, requestId: 'ed1' });
  const p = await ev.prepareAdmission(una, owner); const c = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: una }, owner);
  const antes = structuredClone(ev.store.rows.get('eventos/' + c.eventId)), escrituras = ev.store.writes.length;
  const sim = await ev.update({ eventId: c.eventId, negocioId: 'b', expectedVersion: 1, changes: { descripcion: 'Descripción nueva y mejor' }, reason: 'Mejorar texto', simular: true }, owner);
  assert.equal(sim.simulado, true); assert.equal(sim.escrito, false); assert.ok(sim.camposQueCambian.includes('descripcion')); assert.equal(sim.versionResultante, 2);
  assert.equal(ev.store.writes.length, escrituras); assert.deepEqual(ev.store.rows.get('eventos/' + c.eventId), antes);
  await assert.rejects(ev.update({ eventId: c.eventId, negocioId: 'b', expectedVersion: 9, changes: { descripcion: 'x yy' }, reason: 'versión mala', simular: true }, owner), e => e.code === 'version_conflict');
  const real = await ev.update({ eventId: c.eventId, negocioId: 'b', expectedVersion: 1, changes: { descripcion: 'Descripción nueva y mejor' }, reason: 'Mejorar texto' }, owner);
  assert.equal(real.version, 2); assert.equal(ev.store.rows.get('eventos/' + c.eventId).data.descripcion, 'Descripción nueva y mejor');
});
