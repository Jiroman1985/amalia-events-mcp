import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalInput, record, ETIQUETAS } from '../event-domain.mjs';
import { EventService } from '../event-service.mjs';
import { HistoricalFixtureService } from './helpers/historical-fixtures.mjs';
import { DomainError } from '../event-domain.mjs';

const owner = { id: 'owner', actions: ['*'], businesses: ['*'] };
const hark = { id: 'hark', actions: ['admit', 'read'], businesses: ['*'] };
const base = (o = {}) => ({ negocioId: 'b', titulo: 'Taller de ensayo', descripcion: 'Descripción de ensayo', city: 'Almagro', fechaLocal: '2027-01-10', sesionId: 's1', fuentes: [{ url: 'https://example.org/a' }], ...o });
const code = f => { try { f(); } catch (e) { return e.code; } return null; };

test('etiquetas: vocabulario cerrado, máximo 8 y sin repetidos', () => {
  assert.equal(ETIQUETAS.length, 16);
  assert.deepEqual(canonicalInput(base({ etiquetas: ['musica', 'aire_libre'] })).etiquetas, ['musica', 'aire_libre']);
  assert.equal(code(() => canonicalInput(base({ etiquetas: ['musica', 'pop'] }))), 'invalid_tags');
  assert.equal(code(() => canonicalInput(base({ etiquetas: ['musica', 'musica'] }))), 'invalid_tags');
  assert.equal(code(() => canonicalInput(base({ etiquetas: ETIQUETAS.slice(0, 9) }))), 'invalid_tags');
  assert.equal(canonicalInput(base({ etiquetas: ETIQUETAS.slice(0, 8) })).etiquetas.length, 8);
});

test('los campos nuevos son opcionales y su ausencia no cambia el resultado', () => {
  const e = canonicalInput(base());
  for (const k of ['etiquetas', 'direccion', 'fuente_nombre', 'fuente_tipo']) assert.equal(k in e, false);
  const r = record(e, owner);
  for (const k of ['etiquetas', 'direccion', 'fuente_nombre', 'fuente_tipo']) assert.equal(k in r, false);
  assert.equal('etiquetas' in canonicalInput(base({ etiquetas: [] })), false);
});

test('direccion suelta o dentro de ubicacion, hasta 200 caracteres, y se escribe en el nivel superior', () => {
  assert.equal(record(canonicalInput(base({ direccion: '  Calle Mayor 5 ' })), owner).direccion, 'Calle Mayor 5');
  assert.equal(canonicalInput(base({ ubicacion: { municipio: 'Almagro', direccion: 'Plaza Mayor 1' } })).direccion, 'Plaza Mayor 1');
  assert.equal(code(() => canonicalInput(base({ direccion: 'x'.repeat(201) }))), 'invalid_address');
  assert.equal(code(() => canonicalInput(base({ direccion: 'Calle A 1', ubicacion: { municipio: 'Almagro', direccion: 'Calle B 2' } }))), 'conflicting_address');
});

test('fuente_nombre (≤80) y fuente_tipo (enumerado)', () => {
  const r = record(canonicalInput(base({ fuente_nombre: 'Ayuntamiento de Almagro', fuente_tipo: 'oficial' })), owner);
  assert.equal(r.fuente_nombre, 'Ayuntamiento de Almagro'); assert.equal(r.fuente_tipo, 'oficial');
  assert.equal(code(() => canonicalInput(base({ fuente_nombre: 'x'.repeat(81) }))), 'invalid_source_name');
  assert.equal(code(() => canonicalInput(base({ fuente_tipo: 'blog' }))), 'invalid_source_type');
});

class M { constructor() { this.rows = new Map([['negocios/b', { data: { nombre: 'B' }, updateTime: '1' }], ['amalia_catalog_guard/eventos', { data: { epoch: 0 }, updateTime: 'g' }]]); }
  async get(c, id) { const r = this.rows.get(c + '/' + id); return r ? { id, ...structuredClone(r) } : null; }
  async list(c) { return [...this.rows].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.split('/').at(-1), ...structuredClone(r) })); } }

test('preparar_admision: los campos nuevos entran en el hash y en las huellas', async () => {
  const ev = new EventService(new M(), { get() { throw Error('x'); } });
  const a = { ...base({ requestId: 'r1' }), etiquetas: ['musica'], direccion: 'Calle Mayor 5', fuente_nombre: 'Ayuntamiento de Almagro', fuente_tipo: 'oficial' };
  const p = await ev.prepareAdmission(a, hark);
  assert.equal(p.admisible, true);
  assert.deepEqual(p.candidato.etiquetas, ['musica']);
  assert.ok(p.huellaCampos.direccion && p.huellaCampos.fuente_tipo);
  const q = await ev.prepareAdmission({ ...a, etiquetas: ['teatro'] }, hark);
  assert.notEqual(q.proposalHash, p.proposalHash);
  await assert.rejects(ev.admitCandidate({ accion: 'admit', proposalHash: p.proposalHash, evento: { ...a, direccion: 'Otra 9' } }, hark), /proposal_changed/);
});

class MemoryStore {
  constructor() { this.rows = new Map([['negocios/bizA', { data: { nombre: 'A' }, updateTime: '1' }]]); this.seq = 1; }
  async get(c, id) { const r = this.rows.get(c + '/' + id); return r ? { id, ...structuredClone(r) } : null; }
  async list(c) { return [...this.rows].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.split('/').at(-1), ...structuredClone(r) })); }
  async write(c, id, data, { updateTime, create, updateFields } = {}) {
    const key = c + '/' + id, cur = this.rows.get(key);
    if ((create && cur) || (!create && cur?.updateTime !== updateTime)) throw new DomainError('version_conflict');
    let next = structuredClone(data);
    if (updateFields && cur) { next = structuredClone(cur.data); for (const f of updateFields) { if (f in data) next[f] = structuredClone(data[f]); else delete next[f]; } }
    this.rows.set(key, { data: next, updateTime: String(++this.seq) }); return { id };
  }
}
const media = { get() { throw Error('no asset'); } };

test('editar_evento: añade los campos nuevos, marca geo_revision_pendiente y conserva geo*', async () => {
  const store = new MemoryStore(), ev = new HistoricalFixtureService(store, media);
  const e = await ev.create({ negocioId: 'bizA', titulo: 'Concierto de ensayo', descripcion: 'Evento de ensayo.', city: 'Málaga', fechaLocal: '2099-05-10', horaLocal: null, sesionId: 'e1', fuentes: [{ url: 'https://example.org/e', checkedAt: '2026-10-28T07:00:00Z' }], prueba: true, verificationStatus: 'capturado' }, owner);
  // el geocodificador (otro proceso) escribe geo, geo_precision y geo_fuente
  const row = store.rows.get('eventos/' + e.eventId); row.data.geo = { latitude: 36.7, longitude: -4.4 }; row.data.geo_precision = 'ciudad'; row.data.geo_fuente = 'nominatim';
  const r = await ev.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 1, changes: { etiquetas: ['musica', 'accesible'], fuente_tipo: 'oficial', fuente_nombre: 'Ayto. de Málaga' }, reason: 'completar ficha' }, owner);
  assert.deepEqual(r.etiquetas, ['musica', 'accesible']);
  let d = store.rows.get('eventos/' + e.eventId).data;
  assert.equal(d.fuente_tipo, 'oficial'); assert.equal(d.geo_precision, 'ciudad'); assert.equal(d.geo_fuente, 'nominatim'); assert.ok(d.geo);
  assert.notEqual(d.geo_revision_pendiente, true);
  await ev.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 2, changes: { direccion: 'Calle Larios 1' }, reason: 'añadir dirección' }, owner);
  d = store.rows.get('eventos/' + e.eventId).data;
  assert.equal(d.direccion, 'Calle Larios 1'); assert.equal(d.geo_revision_pendiente, true);
  assert.equal(d.geo_precision, 'ciudad'); assert.ok(d.geo);
  await assert.rejects(ev.update({ eventId: e.eventId, negocioId: 'bizA', expectedVersion: 3, changes: { etiquetas: ['nope'] }, reason: 'mal' }, owner), /invalid_tags/);
});

test('candidatos privados aceptan los campos nuevos validados', async () => {
  const store = new MemoryStore(), ev = new EventService(store, media);
  const c = await ev.saveCandidate({ titulo: 'Algo', carencias: ['imagen'], fuentes: ['https://example.org/x'], etiquetas: ['cine'], direccion: 'Calle 1', fuente_tipo: 'plataforma' }, hark);
  assert.deepEqual(c.etiquetas, ['cine']); assert.equal(c.fuente_tipo, 'plataforma');
  await assert.rejects(ev.saveCandidate({ titulo: 'Algo', carencias: ['imagen'], fuentes: ['https://example.org/x'], etiquetas: ['xx'] }, hark), /invalid_tags/);
});
