import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../event-service.mjs';
import { DomainError, authorize } from '../event-domain.mjs';
import { claveSesion, clavesDeEvento, normalizarUrl, recintoClave } from '../clave-sesion.mjs';
import { analizarDuplicados, elegirConservada } from '../auditoria-duplicados.mjs';

const yieldNow = () => new Promise(r => setImmediate(r));
class MemoryStore {
  constructor() { this.rows = new Map([['negocios/b', { data: { nombre: 'N' }, updateTime: '1' }], ['amalia_catalog_guard/eventos', { data: { epoch: 1 }, updateTime: 'g1' }]]); this.seq = 1; this.fullScans = 0; }
  async get(c, id) { await yieldNow(); const r = this.rows.get(c + '/' + id); return r ? { id, ...structuredClone(r) } : null; }
  async list(c, o = {}) {
    await yieldNow(); if (c === 'eventos') this.fullScans++;
    return [...this.rows].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.slice(c.length + 1), ...structuredClone(r) }))
      .filter(r => Object.entries(o.eq || {}).every(([k, v]) => String(r.data[k]) === String(v))).filter(r => !o.estado || r.data.estado === o.estado).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, o.limit || 500);
  }
  async listAll(c) { this.fullScans++; return this.list(c); }
  async write(c, id, data, o = {}) {
    await yieldNow(); // a partir de aquí todo es síncrono: el commit es atómico, como en Firestore
    const key = c + '/' + id, cur = this.rows.get(key);
    if ((o.create && cur) || (!o.create && cur && o.updateTime !== cur.updateTime)) throw new DomainError('version_conflict');
    for (const k of o.claves?.crear || []) if (this.rows.has('sesiones_clave/' + k.id)) throw new DomainError('version_conflict');
    if (o.reserve && this.rows.has('amalia_event_reservations/' + o.reserve.id)) throw new DomainError('version_conflict');
    const next = o.updateFields && cur ? { ...cur.data, ...data } : structuredClone(data);
    this.rows.set(key, { data: next, updateTime: 'u' + (++this.seq) });
    if (o.request) this.rows.set('amalia_event_requests/' + o.request.id, { data: o.request.data, updateTime: 'u' + this.seq });
    if (o.reserve) this.rows.set('amalia_event_reservations/' + o.reserve.id, { data: o.reserve.data, updateTime: 'u' + this.seq });
    for (const k of o.claves?.crear || []) this.rows.set('sesiones_clave/' + k.id, { data: structuredClone(k.data), updateTime: 'u' + this.seq });
    for (const k of o.claves?.borrar || []) this.rows.delete('sesiones_clave/' + k);
    if (c === 'eventos') this.rows.set('amalia_catalog_guard/eventos', { data: { epoch: this.seq }, updateTime: 'g' + this.seq });
    return { id, updateTime: 'u' + this.seq };
  }
  async revisions() { return []; }
  claves() { return [...this.rows].filter(([k]) => k.startsWith('sesiones_clave/')).map(([, r]) => r.data); }
  eventos() { return [...this.rows].filter(([k]) => k.startsWith('eventos/')).map(([k, r]) => ({ id: k.slice(8), data: r.data })); }
}
const alfred = { id: 'alfred', actions: ['*'], businesses: ['*'], agente: 'alfred' };
const conchi = { id: 'conchi', actions: ['admit', 'read', 'complete', 'admit_test'], businesses: ['*'], agente: 'conchi' };
const mk = (modo = 'bloquea') => { const store = new MemoryStore(); return { store, ev: new EventService(store, { get() { throw Error('sin imagen'); } }, { warm: false, claves: modo }) }; };
let n = 0;
const ficha = (o = {}) => ({ negocioId: 'b', titulo: 'Titulo ' + (++n), descripcion: 'Descripción del evento.', city: 'Zizur Mayor', timeZone: 'Europe/Madrid', fuentes: [{ url: 'https://example.org/a/' + n, checkedAt: '2026-11-20T10:00:00Z' }], verificationStatus: 'capturado', fechaLocal: '2099-11-28', horaLocal: '20:00', lugar: 'Casa de Cultura de Zizur Mayor', requestId: 'req-' + n, ...o });
const alta = async (ev, input, p = alfred) => { const pr = await ev.prepareAdmission(input, p); return ev.admitCandidate({ accion: 'admit', proposalHash: pr.proposalHash, evento: input }, p); };
const codigo = async fn => { try { await fn(); return null; } catch (e) { return e instanceof DomainError ? e.code : 'otro:' + e.message; } };

test('clave: el título no forma parte; recinto sin genéricos; vacío si es el municipio; ISO obligatorio', () => {
  assert.equal(recintoClave('Plaza de España', 'Villarrasa'), 'espana');
  assert.equal(recintoClave('Casa de Cultura', 'Zizur Mayor'), 'casa de cultura'); // solo genéricos: no es seguro quitarlos
  assert.equal(recintoClave('Zizur Mayor', 'Zizur Mayor'), '');
  const a = claveSesion({ city: 'Noja', lugar: 'Sala Polivalente del Centro Cívico', fechaLocal: '2099-12-04', horaLocal: '16:30' });
  const b = claveSesion({ city: 'NOJA', lugar: 'sala polivalente centro civico', fechaLocal: '2099-12-04', horaLocal: '16:30' });
  assert.equal(a.clave, b.clave); assert.equal(a.fuerza, 'fuerte');
  assert.equal(claveSesion({ city: 'Noja', fechaLocal: '22 de marzo' }), null);
  assert.equal(claveSesion({ city: 'Noja', fechaLocal: '2099-12-04' }).fuerza, 'debil');
  assert.equal(claveSesion({ city: 'Noja', fechaLocal: '2099-12-04', horaLocal: '10:00' }).fuerza, 'media');
});
test('normalizarUrl: barra final, www, tracking y fragmento no cambian la identidad (caso Villarrasa)', () => {
  assert.equal(normalizarUrl('https://www.example.org/Feria/?utm_source=x#a'), normalizarUrl('https://example.org/Feria'));
});

const CASOS = [
  ['Etena Dena', { city: 'Zizur Mayor', lugar: 'Casa de Cultura de Zizur Mayor', fechaLocal: '2099-11-28', horaLocal: '20:00' }, 'Etena Dena', 'Etena dena - Olatz Larunbe en Zizur Mayor', 'bloqueo'],
  ['Noja', { city: 'Noja', lugar: 'Sala Polivalente del Centro Cívico', fechaLocal: '2099-12-04', horaLocal: '16:30' }, 'Taller de corona navideña', 'Taller Corona de Navidad', 'bloqueo'],
  ['Santa Cecilia', { city: 'A Estrada', lugar: 'Teatro Principal da Estrada', fechaLocal: '2099-11-28', horaLocal: '20:00' }, 'Concierto de Santa Cecilia de la Banda Municipal', 'Concerto de Santa Cecilia da Banda Municipal', 'bloqueo'],
  ['La Matanza', { city: 'La Matanza de Acentejo', lugar: 'Plaza del Mercado', fechaLocal: '2099-12-12', horaLocal: '10:00' }, 'Mercado Navideño de Artesanía de La Matanza de Acentejo', 'Mercado Navideño de Artesanía', 'bloqueo'],
  ['Villarrasa', { city: 'Villarrasa', lugar: 'Plaza de España', fechaLocal: '2099-12-13', horaLocal: '11:00' }, 'II Feria de Antigüedades, Decoración, Artesanía y Coleccionismo', 'II Feria de Antigüedades, Decoración, Artesanía', 'bloqueo'],
  ['Trasterminancia', { city: 'Tamurejo', lugar: 'Tamurejo', fechaLocal: '2099-11-21', horaLocal: undefined }, 'XV Fiesta de la Trasterminancia de Tamurejo a Siruela', 'Fiesta de la Trasterminancia de Tamurejo a Siruela', 'cola'],
];
for (const [nombre, base, t1, t2, esperado] of CASOS) {
  test(`caso real «${nombre}»: la segunda alta con otra URL, otro sesionId y otro agente no crea ficha`, async () => {
    const { store, ev } = mk();
    const uno = await alta(ev, ficha({ ...base, titulo: t1, sesionId: 'agente-a-' + n }), conchi);
    assert.equal(uno.created, true);
    const segunda = ficha({ ...base, titulo: t2, sesionId: 'agente-b-' + n, fuentes: [{ url: 'https://otro.example.net/' + n + '/', checkedAt: '2026-11-20T10:00:00Z' }] });
    const p = await ev.prepareAdmission(segunda, alfred);
    assert.equal(p.admisible, false, 'preparar_admision ya avisa');
    const code = await codigo(() => ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: segunda }, alfred));
    assert.equal(code, esperado === 'cola' ? 'requires_review' : 'duplicate_event_conflict');
    assert.equal(store.eventos().length, 1, 'no se ha creado la ficha duplicada');
  });
}
test('otra hora del mismo título en el mismo recinto es otra sesión (pase distinto) y se admite', async () => {
  const { store, ev } = mk(); const b = { titulo: 'Zambomba flamenca', city: 'Torrox', lugar: 'Villa de Torrox', fechaLocal: '2099-12-07' };
  await alta(ev, ficha({ ...b, horaLocal: '18:00' })); await alta(ev, ficha({ ...b, horaLocal: '21:00' }));
  assert.equal(store.eventos().length, 2);
});
test('sin hora frente a con hora, con título parecido, va a la cola y no crea ficha', async () => {
  const { store, ev } = mk(); const b = { titulo: 'Recital de guitarra Entre cuerdas y vías', city: 'Ronda', lugar: 'Fundación Unicaja', fechaLocal: '2099-12-09' };
  await alta(ev, ficha({ ...b, horaLocal: '19:30' }));
  const c = ficha({ ...b, titulo: 'Entre cuerdas y vías: recital de guitarra', horaLocal: undefined });
  const p = await ev.prepareAdmission(c, alfred); assert.equal(p.admisible, false); assert.equal(p.claves.decision, 'cola');
  assert.equal(await codigo(() => ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: c }, alfred)), 'requires_review');
  assert.equal(store.eventos().length, 1);
});

test('CONCURRENCIA: 5 altas simultáneas de la misma sesión (URL, título y agente distintos): solo entra una', async () => {
  const { store, ev } = mk();
  const base = { city: 'Zizur Mayor', lugar: 'Casa de Cultura de Zizur Mayor', fechaLocal: '2099-11-28', horaLocal: '20:00' };
  const titulos = ['Etena Dena', 'Etena dena - Olatz Larunbe', 'Etena Dena en Zizur Mayor', 'Etena Dena (concierto)', 'Concierto Etena Dena'];
  const inputs = titulos.map((t, i) => ficha({ ...base, titulo: t, fuentes: [{ url: `https://fuente${i}.example.org/etena`, checkedAt: '2026-11-20T10:00:00Z' }], sesionId: 'ses-' + i, requestId: 'conc-' + i }));
  const prep = await Promise.all(inputs.map(i => ev.prepareAdmission(i, alfred)));
  assert.ok(prep.every(p => p.admisible), 'todas ven el catálogo vacío: la carrera es real');
  const res = await Promise.allSettled(inputs.map((i, k) => ev.admitCandidate({ accion: 'admit', proposalHash: prep[k].proposalHash, evento: i }, alfred)));
  const ok = res.filter(r => r.status === 'fulfilled' && r.value.created === true);
  assert.equal(ok.length, 1, 'solo una alta creada');
  for (const r of res.filter(r => r.status === 'rejected')) assert.ok(['session_key_conflict', 'duplicate_event_conflict', 'admission_contended', 'requires_review'].includes(r.reason.code), r.reason.code);
  assert.equal(store.eventos().length, 1); assert.equal(store.claves().filter(c => c.fuerza === 'fuerte').length, 1);
  assert.equal(store.fullScans, 0, 'ninguna escritura recorre la colección');
});
test('CONCURRENCIA con sesiones distintas: todas entran (la clave no bloquea lo legítimo)', async () => {
  const { store, ev } = mk(); const b = { titulo: 'Taller de velas', city: 'Rebollar', lugar: 'Casa del pueblo', fechaLocal: '2099-12-02' };
  const inputs = ['10:30', '12:00', '16:00', '17:30', '19:00'].map((h, i) => ficha({ ...b, horaLocal: h, requestId: 'ok-' + i }));
  const res = await Promise.allSettled(inputs.map(async i => alta(ev, i)));
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 5); assert.equal(store.eventos().length, 5);
});
test('idempotencia: repetir la misma alta devuelve lo mismo sin crear; idempotencyKey equivale a requestId', async () => {
  const { store, ev } = mk(); const i = ficha({ requestId: undefined, idempotencyKey: 'idem-1' });
  const a = await alta(ev, i), b = await alta(ev, i);
  assert.equal(a.created, true); assert.equal(b.alreadyCreated, true); assert.equal(b.eventId, a.eventId); assert.equal(store.eventos().length, 1);
});
test('en modo bloquea una alta sin requestId/idempotencyKey se rechaza con el nombre del campo', async () => {
  const { ev } = mk(); const i = ficha({ requestId: undefined }); const p = await ev.prepareAdmission(i, alfred);
  await assert.rejects(ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: i }, alfred), e => e.code === 'invalid_field' && e.details.campo === 'requestId');
});
test('confirmarOtraSesion ya no permite saltarse un aviso en modo bloquea', async () => {
  const { ev } = mk(); await assert.rejects(ev.prepareAdmission(ficha({ confirmarOtraSesion: { eventIds: ['ev_x'], motivo: 'otra sesión', evidenciaUrl: 'https://example.org/x' } }), alfred), e => e.code === 'invalid_field' && e.details.campo === 'confirmarOtraSesion');
});
test('preparar y admitir no recorren el catálogo ni cargan el universo (consultas por clave)', async () => {
  const { store, ev } = mk(); for (let i = 0; i < 5; i++) await alta(ev, ficha({ city: 'Torrox', fechaLocal: '2099-12-0' + (i + 1), horaLocal: '1' + i + ':00', lugar: 'Sala ' + i }));
  assert.equal(store.fullScans, 0);
});

test('retirar libera la clave; recuperar la recupera; si otra ficha la ocupa, recuperar da session_key_conflict', async () => {
  const { store, ev } = mk(); const base = { city: 'Noja', lugar: 'Sala Polivalente', fechaLocal: '2099-12-04', horaLocal: '16:30' };
  const a = await alta(ev, ficha({ ...base, titulo: 'Taller corona' }));
  const pre = await ev.retirePreview({ eventId: a.eventId, negocioId: 'b' }, alfred).catch(() => null);
  const row = await store.get('eventos', a.eventId);
  await ev.retire({ eventId: a.eventId, negocioId: 'b', expectedVersion: row.data.version || 0, motivo: 'duplicado', codigoConfirmacion: ev.confirmationCode(row) }, alfred);
  assert.equal(store.claves().length, 0);
  const b = await alta(ev, ficha({ ...base, titulo: 'Taller corona navideña' }));
  assert.equal(store.claves().length, 1);
  const r2 = await store.get('eventos', a.eventId);
  await assert.rejects(ev.restore({ eventId: a.eventId, negocioId: 'b', expectedVersion: r2.data.version, motivo: 'por error' }, alfred), e => e.code === 'session_key_conflict' && e.details.eventId === b.eventId);
});
test('editar la hora mueve la clave en el mismo commit; chocar con otra clave fuerte se rechaza', async () => {
  const { store, ev } = mk(); const base = { city: 'Noja', lugar: 'Sala Polivalente', fechaLocal: '2099-12-04' };
  const a = await alta(ev, ficha({ ...base, titulo: 'Obra uno', horaLocal: '16:30' })), b = await alta(ev, ficha({ ...base, titulo: 'Concierto distinto', horaLocal: '19:00' }));
  const antes = store.claves().map(c => c.hora).sort();
  assert.deepEqual(antes, ['16:30', '19:00']);
  const v0 = (await store.get('eventos', a.eventId)).data.version;
  await ev.update({ eventId: a.eventId, negocioId: 'b', expectedVersion: v0, changes: { horaLocal: '17:00' }, reason: 'cambio de hora', evidenciaUrl: 'https://example.org/h' }, alfred);
  assert.deepEqual(store.claves().map(c => c.hora).sort(), ['17:00', '19:00']);
  const code = await codigo(() => ev.update({ eventId: a.eventId, negocioId: 'b', expectedVersion: v0 + 1, changes: { horaLocal: '19:00' }, reason: 'otra hora', evidenciaUrl: 'https://example.org/h' }, alfred));
  assert.ok(['session_key_conflict', 'duplicate_event_conflict'].includes(code), code);
});
test('modo sombra: no bloquea, mantiene claves y registra la comparación; modo off no escribe claves', async () => {
  const s = mk('sombra'), base = { city: 'Torrox', lugar: 'Villa de Torrox', fechaLocal: '2099-12-07', horaLocal: '18:00' };
  await alta(s.ev, ficha({ ...base, titulo: 'José Ortiz y Macarena' }));
  const p = await s.ev.prepareAdmission(ficha({ ...base, titulo: 'Concierto distinto totalmente' }), alfred);
  assert.equal(p.admisible, true, 'en sombra no bloquea'); assert.equal(p.clavesSombra.decision, 'cola');
  await alta(s.ev, ficha({ ...base, titulo: 'Concierto distinto totalmente' })); assert.equal(s.store.eventos().length, 2); assert.equal(s.store.claves().length, 1, 'la clave fuerte ocupada se omite');
  const o = mk('off'); await alta(o.ev, ficha(base)); assert.equal(o.store.claves().length, 0);
});

test('la cola: lo dudoso no crea ficha, es idempotente y solo Alfred la resuelve', async () => {
  const { store, ev } = mk(); const b = { city: 'Tamurejo', lugar: 'Tamurejo', fechaLocal: '2099-11-21', horaLocal: undefined };
  await alta(ev, ficha({ ...b, titulo: 'XV Fiesta de la Trasterminancia de Tamurejo a Siruela' }));
  const c = ficha({ ...b, titulo: 'Fiesta de la Trasterminancia de Tamurejo a Siruela' });
  const p = await ev.prepareAdmission(c, alfred);
  const e1 = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: c }, conchi).catch(e => e);
  const e2 = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: c }, conchi).catch(e => e);
  assert.equal(e1.code, 'requires_review'); assert.equal(e1.details.colaId, e2.details.colaId);
  assert.equal((await ev.listarRevision({}, conchi)).items.length, 1); assert.equal(store.eventos().length, 1);
  await assert.rejects(ev.resolverRevision({ colaId: e1.details.colaId, accion: 'descartar', motivo: 'no me toca' }, conchi), e => e.code === 'forbidden' && e.details.accionRequerida === 'board_admin');
  const sim = await ev.resolverRevision({ colaId: e1.details.colaId, accion: 'admitir_distinta', motivo: 'es otra fiesta', simular: true }, alfred);
  assert.equal(sim.escrito, false); assert.equal(store.eventos().length, 1);
  const r = await ev.resolverRevision({ colaId: e1.details.colaId, accion: 'admitir_distinta', motivo: 'es otra edición distinta', discriminador: 'segunda fiesta' }, alfred);
  assert.equal(r.estado, 'admitida'); assert.equal(store.eventos().length, 2);
  await assert.rejects(ev.resolverRevision({ colaId: e1.details.colaId, accion: 'descartar', motivo: 'otra vez' }, alfred), e => e.code === 'review_already_resolved');
});
test('la cola: descartar y fusionar no crean ficha; fusionar rellena huecos del existente', async () => {
  const { store, ev } = mk(); const b = { city: 'Ronda', lugar: 'Fundación Unicaja', fechaLocal: '2099-12-09' };
  const ex = await alta(ev, ficha({ ...b, titulo: 'Recital de guitarra Entre cuerdas y vías', horaLocal: '19:30' }));
  const c = ficha({ ...b, titulo: 'Entre cuerdas y vías recital de guitarra', horaLocal: undefined, direccion: 'Calle Sor Ángela de la Cruz 1', fuentes: [{ url: 'https://otra.example.net/guitarra', checkedAt: '2026-11-20T10:00:00Z' }] });
  const p = await ev.prepareAdmission(c, alfred); const e1 = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: c }, alfred).catch(e => e);
  const r = await ev.resolverRevision({ colaId: e1.details.colaId, accion: 'fusionar', eventIdDestino: ex.eventId, motivo: 'es el mismo recital' }, alfred);
  assert.equal(r.estado, 'fusionada'); assert.equal(store.eventos().length, 1);
  assert.equal(store.eventos()[0].data.direccion, 'Calle Sor Ángela de la Cruz 1'); assert.ok(store.eventos()[0].data.fuentes.length >= 2);
});

test('forbidden indica la acción que falta (no es un error de campo)', () => {
  assert.throws(() => authorize({ id: 'x', actions: ['read'], businesses: ['*'] }, null, 'review'), e => e.code === 'forbidden' && e.details.accionRequerida === 'review');
});
test('completar_evento con simular no escribe', async () => {
  const { store, ev } = mk(); const a = await alta(ev, ficha({ horaLocal: undefined, lugar: undefined }));
  const antes = JSON.stringify(store.eventos());
  const v = (await store.get('eventos', a.eventId)).data.version;
  const r = await ev.complete({ eventId: a.eventId, negocioId: 'b', expectedVersion: v, campos: { horaLocal: '10:00' }, motivo: 'hora de la fuente', evidenciaUrl: 'https://example.org/h', simular: true }, alfred);
  assert.equal(r.simulado, true); assert.equal(JSON.stringify(store.eventos()), antes);
});

test('auditoría: agrupa exactos seguros y dudosos, elige la ficha más completa y no escribe', () => {
  const mkd = (id, extra) => ({ id, data: { titulo: 'Mercado Navideño', city: 'Almodóvar del Río', lugar: 'Carpa recinto ferial', fechaLocal: '2099-12-13', horaLocal: '12:00', negocioId: 'b', fechaCreacion: '2099-01-0' + id.length, ...extra } });
  const rows = [mkd('ev_a', { descripcion: 'x' }), mkd('ev_bb', { titulo: 'XIV Mercado Navideño en la carpa', descripcion: 'x', assetId: 'as_1' }), mkd('ev_c', { city: 'Otro', titulo: 'Concierto' }),
    { id: 'ev_d', data: { titulo: 'Recital guitarra Entre cuerdas', city: 'Ronda', lugar: 'Fundación', fechaLocal: '2099-12-09', horaLocal: '19:30', negocioId: 'b' } },
    { id: 'ev_e', data: { titulo: 'Entre cuerdas recital guitarra', city: 'Ronda', lugar: 'Fundación', fechaLocal: '2099-12-09', negocioId: 'b' } }];
  const r = analizarDuplicados(rows);
  assert.equal(r.exactos.length, 1); assert.deepEqual([r.exactos[0].a, r.exactos[0].b].sort(), ['ev_a', 'ev_bb']);
  assert.equal(r.dudosos.length, 1);
  assert.equal(elegirConservada(rows[0], rows[1])[0].id, 'ev_bb');
});
test('fusionarPar: conserva la ficha elegida, mueve datos y RETIRA la otra (nunca borra); simular no escribe', async () => {
  const { store, ev } = mk(); const b = { city: 'Torrox', lugar: 'Villa de Torrox', fechaLocal: '2099-12-07', horaLocal: '18:00' };
  const k = await alta(ev, ficha({ ...b, titulo: 'José Ortiz y Macarena' }));
  // la otra se fuerza en el catálogo (histórica, sin clave) para simular un duplicado ya existente
  const o = await alta(ev, ficha({ ...b, titulo: 'Otra', horaLocal: '20:00', direccion: 'Calle Mayor 1' }));
  const sim = await ev.fusionarPar({ conservarId: k.eventId, retirarId: o.eventId, motivo: 'duplicado', simular: true }, alfred);
  assert.equal(sim.escrito, false); assert.ok(sim.camposAAplicar.includes('direccion'));
  const r = await ev.fusionarPar({ conservarId: k.eventId, retirarId: o.eventId, motivo: 'duplicado' }, alfred);
  assert.equal(r.retirada, o.eventId); assert.equal(store.rows.get('eventos/' + o.eventId).data.retirado, true);
  assert.equal(store.rows.get('eventos/' + k.eventId).data.direccion, 'Calle Mayor 1'); assert.equal(store.eventos().length, 2);
});

// ---- Capa MCP: errores honestos (campo desconocido → validación con el nombre del campo, nunca forbidden) ----
import { createApp } from '../server-v2.mjs';
import { hash } from '../event-domain.mjs';
test('MCP: un campo desconocido en buscar_duplicados_global o editar_evento devuelve error de validación con el nombre; las herramientas nuevas existen', async () => {
  const principal = { id: 'test', tokenHash: hash('fixture-token-not-for-production'), actions: ['read'], businesses: ['*'] };
  const app = createApp({ editorial: { pausedNow: () => true }, publicBase: 'https://example.org', media: { serve: () => null }, events: { findDuplicates: async () => ({ coincidencias: [], informativas: [] }) } }, [principal]);
  await new Promise(r => app.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + app.address().port;
  const send = body => fetch(base + '/mcp', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer fixture-token-not-for-production' } }).then(r => r.json());
  try {
    const names = (await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map(t => t.name);
    for (const t of ['listar_revision_candidatos', 'resolver_revision_candidato']) assert.ok(names.includes(t), t);
    const mala = await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buscar_duplicados_global', arguments: { titulo: 'x', desdeFecha: '2099-01-01' } } });
    const txt = JSON.stringify(mala);
    assert.ok(/desdeFecha/.test(txt), 'el error nombra el campo'); assert.ok(!/forbidden/.test(txt));
    const buena = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'buscar_duplicados_global', arguments: { titulo: 'x', municipio: 'Noja', desde: '2099-01-01', hasta: '2099-12-31' } } });
    assert.ok(!buena.result.isError, 'municipio, desde y hasta son filtros reales');
  } finally { app.closeAllConnections(); await new Promise(r => app.close(r)); }
});

test('claves débiles (sin hora ni recinto): título distinto pasa, título idéntico bloquea, título parecido va a la cola', async () => {
  const { store, ev } = mk(); const b = { city: 'Tías', lugar: undefined, horaLocal: undefined, fechaLocal: '2099-12-12' };
  await alta(ev, ficha({ ...b, titulo: 'Muestra de artesanía por Navidad' }));
  await alta(ev, ficha({ ...b, titulo: 'Concierto de la banda municipal' })); // otro título: pasa
  assert.equal(store.eventos().length, 2);
  const igual = ficha({ ...b, titulo: 'Muestra de artesanía por Navidad' });
  assert.equal((await ev.prepareAdmission(igual, alfred)).claves.decision, 'bloquea');
  const parecido = ficha({ ...b, titulo: 'Muestra artesanía Navidad en Tías' });
  assert.equal((await ev.prepareAdmission(parecido, alfred)).claves.decision, 'cola');
});
test('la procedenciaRegistro se conserva al resolver desde la cola (se guarda al encolar y se revalida con review acotado)', async () => {
  const { store, ev } = mk(); const llamadas = [];
  ev.registryContext = async (raw, e, p) => { if (raw === undefined) return null; llamadas.push({ raw, review: p.actions.includes('review') || p.actions.includes('*') }); return { hash: 'a'.repeat(64), input: raw, verify: { collection: 'registro_fuentes', key: 'f1', updateTime: 't' }, record: { policy: 'registro-v1', fuenteId: raw.fuenteId } }; };
  const b = { city: 'Ronda', lugar: 'Fundación Unicaja', fechaLocal: '2099-12-09' };
  await alta(ev, ficha({ ...b, titulo: 'Recital de guitarra Entre cuerdas y vías', horaLocal: '19:30' }));
  const prov = { version: 1, fuenteId: 'fte_web_x', canalFuente: 'web' };
  const c = ficha({ ...b, titulo: 'Entre cuerdas y vías recital de guitarra', horaLocal: undefined, procedenciaRegistro: prov });
  const p = await ev.prepareAdmission(c, alfred);
  const e1 = await ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: c }, alfred).catch(e => e);
  assert.equal(e1.code, 'requires_review');
  const item = (await store.get('revisar_candidatos', e1.details.colaId)).data; assert.deepEqual(item.procedenciaRegistro, prov);
  assert.equal(item.evento.procedenciaRegistro, undefined, 'el evento guardado no mezcla la procedencia');
  const restricted = { ...alfred, actions: ['admit', 'read', 'complete', 'board_admin', 'retire'] };
  llamadas.length = 0;
  const r = await ev.resolverRevision({ colaId: e1.details.colaId, accion: 'admitir_distinta', motivo: 'es otra sesión', discriminador: 'sin hora' }, restricted);
  assert.equal(r.estado, 'admitida'); assert.deepEqual(llamadas[0].raw, prov); assert.equal(llamadas[0].review, true);
  const ev1 = store.rows.get('eventos/' + r.eventId).data; assert.equal(ev1.provenanceHash, 'a'.repeat(64)); assert.equal(ev1.procedenciaRegistro.fuenteId, 'fte_web_x');
});
