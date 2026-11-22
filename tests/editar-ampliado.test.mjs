import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, originKey } from '../event-domain.mjs';
import { HistoricalFixtureService as EventService } from './helpers/historical-fixtures.mjs';
import { EventService as RealService } from '../event-service.mjs';
import { ProgramAdmission } from '../program-admission.mjs';
import { sources as _sources } from '../event-domain.mjs';

const owner = { id: 'owner', actions: ['*'], businesses: ['*'] };
const editor = { id: 'editor', actions: ['read', 'edit'], businesses: ['bizA'] };
const completer = { id: 'hark', actions: ['read', 'admit', 'complete'], businesses: ['*'] };
const noComplete = { id: 'sin', actions: ['read', 'admit', 'edit'], businesses: ['*'] };
const EV = 'https://almagro.es/agenda/concierto';

class MemoryStore {
  constructor() { this.rows = new Map([['negocios/bizA', { data: { nombre: 'Ayuntamiento de Almagro' }, updateTime: '1' }]]); this.seq = 1; this.audit = []; this.moves = []; }
  async get(c, id) { const r = this.rows.get(`${c}/${id}`); return r ? { id, ...structuredClone(r) } : null; }
  async list(c) { return [...this.rows].filter(([k]) => k.startsWith(c + '/')).map(([k, r]) => ({ id: k.split('/').at(-1), ...structuredClone(r) })).sort((a, b) => (a.id < b.id ? -1 : 1)); }
  async write(c, id, data, { updateTime, create, updateFields, audit, moveReserve, guard } = {}) {
    const key = `${c}/${id}`, cur = this.rows.get(key);
    if ((create && cur) || (!create && cur?.updateTime !== updateTime)) throw new DomainError('version_conflict');
    if (guard?.updateTime && this.rows.get('amalia_catalog_guard/eventos').updateTime !== guard.updateTime) throw new DomainError('version_conflict');
    let next = structuredClone(data);
    if (updateFields && cur) { next = structuredClone(cur.data); for (const f of updateFields) { if (f in data) next[f] = structuredClone(data[f]); else delete next[f]; } }
    this.rows.set(key, { data: next, updateTime: String(++this.seq) });
    if (c === 'eventos') { const g = this.rows.get('amalia_catalog_guard/eventos'); if (g) g.updateTime = 'g' + this.seq; }
    if (moveReserve) { this.rows.delete('amalia_event_reservations/' + moveReserve.from); this.rows.set('amalia_event_reservations/' + moveReserve.to.id, { data: structuredClone(moveReserve.to.data), updateTime: String(++this.seq) }); this.moves.push(moveReserve); }
    if (audit) this.audit.push(structuredClone(audit));
    return { id, data, updateTime: String(this.seq) };
  }
}
const ev = (o = {}) => ({ negocioId: 'bizA', titulo: 'Concierto de ensayo', descripcion: 'Evento de ensayo.', city: 'Almagro', fechaLocal: '2099-05-10', horaLocal: null, timeZone: 'Europe/Madrid', fuentes: [{ url: EV, checkedAt: '2026-11-01T10:00:00.000Z' }], prueba: true, ...o });
async function fx(input = ev()) {
  const store = new MemoryStore(), events = new EventService(store, { get() { throw Error('no asset'); } });
  const e = await events.create(input, owner);
  return { store, events, e, row: () => store.rows.get('eventos/' + e.eventId).data };
}
const upd = (f, changes, o = {}, p = owner) => f.events.update({ eventId: f.e.eventId, negocioId: 'bizA', expectedVersion: f.row().version, changes, reason: 'cambio anunciado por la fuente', ...o }, p);

test('cambiar fecha u hora exige evidenciaUrl y registra evidencia, versión y auditoría', async () => {
  const f = await fx();
  await assert.rejects(upd(f, { fechaLocal: '2099-05-12' }), /evidence_required/);
  await assert.rejects(upd(f, { fechaLocal: '2099-05-12' }, { evidenciaUrl: 'http://x.es/a' }), /evidence_required/);
  const r = await upd(f, { fechaLocal: '2099-05-12', horaLocal: '20:30' }, { evidenciaUrl: EV });
  assert.equal(r.version, 2); assert.equal(r.fechaLocal, '2099-05-12'); assert.equal(r.horaLocal, '20:30');
  assert.equal(f.row().fecha_inicio, '2099-05-12'); assert.equal(f.row().hora, '20:30'); assert.equal(f.row().evidenciaUrl, EV);
  assert.ok(f.row().dateTime.startsWith('2099-05-12T18:30'));
  assert.equal(f.store.audit.at(-1).evidenciaUrl, EV); assert.equal(f.store.audit.at(-1).reason, 'cambio anunciado por la fuente');
  await assert.rejects(f.events.update({ eventId: f.e.eventId, negocioId: 'bizA', expectedVersion: 1, changes: { horaLocal: '21:00' }, reason: 'x y z', evidenciaUrl: EV }, owner), /version_conflict/);
});

test('un cambio de fecha que choca con otro evento se rechaza tras el escaneo exhaustivo', async () => {
  const f = await fx();
  await f.events.create(ev({ titulo: 'Concierto de ensayo', fechaLocal: '2099-06-01', sesionId: 'otra', fuentes: [{ url: 'https://almagro.es/agenda/otro' }] }), owner);
  await assert.rejects(upd(f, { fechaLocal: '2099-06-01' }, { evidenciaUrl: EV }), /duplicate_event_conflict/);
  assert.equal(f.row().fechaLocal, '2099-05-10');
});

test('título: solo cambia de forma', async () => {
  const f = await fx(ev({ titulo: 'CONCIERTO DE ENSAYO - 10 de mayo 2099 en Almagro' }));
  const r = await upd(f, { titulo: 'Concierto de ensayo' }, { evidenciaUrl: EV });
  assert.equal(r.titulo, 'Concierto de ensayo'); assert.equal(f.row().nombre, 'Concierto de ensayo');
  await assert.rejects(upd(f, { titulo: 'Obra de teatro' }, { evidenciaUrl: EV }), /title_meaning_changed/);
});

test('fuentes se fusionan: nunca se quitan, las nuevas van al final y la primera es la del organizador', async () => {
  const f = await fx(ev({ fuentes: [{ url: EV }] }));
  f.row().fuentes = [{ url: 'https://www.aemet.es/es/eltiempo', checkedAt: null, sourceId: null }, { url: 'https://maps.google.com/x', checkedAt: null, sourceId: null }]; // legado
  await upd(f, { fuentes: [{ url: EV, checkedAt: '2026-11-12T10:00:00Z' }] }, { evidenciaUrl: EV });
  assert.equal(f.row().fuentes[0].url, EV);
  assert.deepEqual(f.row().fuentes.map(s => s.url), [EV, 'https://www.aemet.es/es/eltiempo', 'https://maps.google.com/x']);
  await upd(f, { fuentes: [{ url: 'https://agenda.example.org/e1' }] }, { evidenciaUrl: EV });
  assert.equal(f.row().fuentes.at(-1).url, 'https://agenda.example.org/e1');
  assert.equal(f.row().fuentes.length, 4);
});

test('la admisión rechaza una primera fuente de comprobación', async () => {
  const store = new MemoryStore(); store.rows.set('amalia_catalog_guard/eventos', { data: { epoch: 0 }, updateTime: 'g' });
  const svc = new RealService(store, { get() {} });
  for (const url of ['https://www.aemet.es/x', 'https://www.google.com/search?q=a', 'https://feverup.com/m/1'])
    await assert.rejects(svc.prepareAdmission(ev({ fuentes: [{ url }, { url: EV }], requestId: 'r' }), owner), /source_primary_not_organizer/);
  assert.equal((await svc.prepareAdmission(ev({ fuentes: [{ url: EV }, { url: 'https://www.aemet.es/x' }], requestId: 'r' }), owner)).admisible, true);
});

test('cancelación: escribe estado=cancelado además de verificationStatus; revertirla lo quita', async () => {
  const f = await fx();
  await upd(f, { verificationStatus: 'cancelado' });
  assert.equal(f.row().verificationStatus, 'cancelado'); assert.equal(f.row().estado, 'cancelado');
  await upd(f, { verificationStatus: 'capturado' });
  assert.equal(f.row().verificationStatus, 'capturado'); assert.equal('estado' in f.row(), false);
});

test('cambiar lugar, city o direccion marca geo_revision_pendiente; geo* del geocodificador sobrevive a otras ediciones', async () => {
  const f = await fx(ev({ geoUbicacion: { lat: 38.88, lng: -3.71, tipo: 'municipio', fuente: 'OpenStreetMap' } }));
  Object.assign(f.row(), { geo: { latitude: 38.8, longitude: -3.7 }, geo_precision: 'lugar', geo_fuente: 'nominatim' }); // el geocodificador mejoró la precisión
  await upd(f, { precio: 5 });
  assert.equal(f.row().geo_precision, 'lugar'); assert.equal(f.row().geo_fuente, 'nominatim'); assert.notEqual(f.row().geo_revision_pendiente, true);
  await upd(f, { lugar: 'Corral de Comedias' }, { evidenciaUrl: EV });
  assert.equal(f.row().lugar, 'Corral de Comedias'); assert.equal(f.row().geo_revision_pendiente, true); assert.equal(f.row().geo_precision, 'lugar');
  f.row().geo_revision_pendiente = false;
  await upd(f, { direccion: 'Plaza Mayor 1' });
  assert.equal(f.row().geo_revision_pendiente, true);
  f.row().geo_revision_pendiente = false;
  await upd(f, { city: 'Ciudad Real' }, { evidenciaUrl: EV });
  assert.equal(f.row().geo_revision_pendiente, true);
});

test('origen: solo cambia id_sesion y la reserva se mueve en la misma operación', async () => {
  const origen = { proveedor: 'almagro.es', id_externo: 'prog1', id_sesion: 's1' };
  const f = await fx(ev({ origen }));
  f.store.rows.set('amalia_event_reservations/' + originKey(origen), { data: { eventId: f.e.eventId, negocioId: 'bizA', origen }, updateTime: '9' });
  await assert.rejects(upd(f, { origen: { ...origen, id_externo: 'otro' } }, { evidenciaUrl: EV }), /origin_identity_immutable/);
  await assert.rejects(upd(f, { sesionId: 'x' }, { evidenciaUrl: EV }), /session_id_follows_origin/);
  const nuevo = { ...origen, id_sesion: 's2' };
  const r = await upd(f, { origen: nuevo }, { evidenciaUrl: EV });
  assert.equal(r.sesionId, 's2'); assert.deepEqual(f.row().origen, nuevo);
  assert.equal(f.store.rows.has('amalia_event_reservations/' + originKey(origen)), false);
  assert.equal(f.store.rows.get('amalia_event_reservations/' + originKey(nuevo)).data.eventId, f.e.eventId);
});

const comp = (f, campos, o = {}, p = completer) => f.events.complete({ eventId: f.e.eventId, negocioId: 'bizA', expectedVersion: f.row().version, campos, motivo: 'completar ficha', ...o }, p);

test('completar_evento rellena solo huecos y explica lo omitido', async () => {
  const f = await fx(ev({ direccion: 'Calle Vieja 3', etiquetas: ['musica'] }));
  const r = await comp(f, { direccion: 'Otra 9', etiquetas: ['teatro', 'musica'], fuente_tipo: 'oficial', fuente_nombre: 'Ayuntamiento de Almagro' });
  assert.deepEqual(r.aplicados.sort(), ['etiquetas', 'fuente_nombre', 'fuente_tipo']);
  assert.deepEqual(r.omitidos, [{ campo: 'direccion', motivo: 'ya_tiene_valor' }]);
  assert.equal(f.row().direccion, 'Calle Vieja 3'); assert.deepEqual(f.row().etiquetas, ['musica', 'teatro']); assert.equal(f.row().fuente_tipo, 'oficial');
  const again = await comp(f, { fuente_tipo: 'otra', etiquetas: ['musica'] });
  assert.equal(again.completado, false); assert.equal(f.row().version, 2); assert.equal(f.row().fuente_tipo, 'oficial');
  assert.equal(f.store.audit.at(-1).action, 'completed');
});

test('completar_evento: hora y lugar exigen evidencia; no pisa una hora existente', async () => {
  const f = await fx();
  await assert.rejects(comp(f, { horaLocal: '19:00' }), /evidence_required/);
  const r = await comp(f, { horaLocal: '19:00', lugar: 'Corral de Comedias' }, { evidenciaUrl: EV });
  assert.equal(f.row().horaLocal, '19:00'); assert.equal(f.row().lugar, 'Corral de Comedias'); assert.equal(f.row().geo_revision_pendiente, true); assert.equal(r.completado, true);
  const r2 = await comp(f, { horaLocal: '21:00', lugar: 'Otro' }, { evidenciaUrl: EV });
  assert.equal(r2.completado, false); assert.equal(f.row().horaLocal, '19:00');
});

test('completar_evento: precio, categorías, precisión de ubicación y fuentes', async () => {
  const f = await fx();
  const geoM = { lat: 38.88, lng: -3.71, tipo: 'municipio', fuente: 'OpenStreetMap' }, geoR = { lat: 38.887, lng: -3.706, tipo: 'recinto', fuente: 'web oficial del recinto' };
  f.row().lugar = 'Corral de Comedias';
  await comp(f, { geoUbicacion: geoM, precioInfo: { estado: 'gratis' }, categorias: ['Arte y creatividad'], fuentes: [{ url: 'https://agenda.example.org/e' }] });
  assert.equal(f.row().geo_precision, 'ciudad'); assert.equal(f.row().precioEstado, 'gratis'); assert.deepEqual(f.row().categorias, ['Arte y creatividad']);
  assert.equal(f.row().fuentes[0].url, EV); assert.equal(f.row().fuentes.at(-1).url, 'https://agenda.example.org/e');
  const r = await comp(f, { geoUbicacion: geoM, precioInfo: { estado: 'precio', cantidad: 5 }, categorias: ['Business'] });
  assert.equal(r.completado, false);
  await comp(f, { geoUbicacion: geoR });
  assert.equal(f.row().geo_precision, 'lugar'); assert.equal(f.row().precioEstado, 'gratis');
});

test('completar_evento exige el permiso complete y no permite campos de identidad', async () => {
  const f = await fx();
  await assert.rejects(comp(f, { direccion: 'x' }, {}, noComplete), /forbidden/);
  await assert.rejects(f.events.complete({ eventId: f.e.eventId, negocioId: 'bizA', expectedVersion: 1, campos: { fechaLocal: '2099-05-12' }, motivo: 'x y z' }, completer), /complete_field_not_allowed/);
  await assert.rejects(f.events.update({ eventId: f.e.eventId, negocioId: 'bizA', expectedVersion: 1, changes: { direccion: 'x' }, reason: 'x y z' }, completer), /forbidden/);
});

test('admisión de programa oficial: el servidor declara fuente_tipo=oficial y fuente_nombre', async () => {
  const store = { get: async (c, id) => ({ id, data: { nombre: 'Universidad de Salamanca' }, updateTime: '1' }) };
  class P extends ProgramAdmission {
    async load() {
      const url = 'https://www.usal.es/programa/taller';
      return { programKey: 'program_x', institution: 'usal.es', business: { id: 'b', data: { nombre: 'Universidad de Salamanca' } }, p: {}, urls: [url], captures: [{ finalUrl: url, capturedAt: '2026-11-10T10:00:00.000Z' }],
        units: [{ unidadId: 'u1', carencias: [], sourceUrl: url, factsHash: 'h', facts: { titulo: 'Taller de setas', descripcion: 'Taller institucional', fechaLocal: '2099-03-03', horaLocal: '10:00', timeZone: 'Europe/Madrid', city: 'Salamanca', lugar: 'Facultad de Biología', provincia: 'Salamanca', pais: 'España', tipo: 'evento', precioInfo: { estado: 'gratis' } } }] };
    }
  }
  const programs = new P(store), b = { id: 'b', data: {} };
  const bundle = await programs.load(), input = programs.candidate(bundle, bundle.units[0], 'rq1');
  assert.equal('fuente_tipo' in input, false);                       // el agente no lo declara
  const out = await programs.evaluate(input, b);
  assert.equal(out.event.fuente_tipo, 'oficial'); assert.equal(out.event.fuente_nombre, 'Universidad de Salamanca');
  await assert.rejects(programs.evaluate({ ...input, fuente_tipo: 'otra' }, b), /source_discrepancy/); // ni puede cambiarlo
});

test('prueba:true exige admit_test, titulo [PRUEBA] y proveedor prueba-*; no afecta a eventos reales', async () => {
  const store = new MemoryStore(); store.rows.set('amalia_catalog_guard/eventos', { data: { epoch: 0 }, updateTime: 'g' });
  const svc = new RealService(store, { get() {} });
  const ing = { id: 'claude-ingesta', actions: ['admit', 'read', 'complete', 'admit_test'], businesses: ['*'] };
  const normal = { id: 'alfred', actions: ['admit', 'read', 'complete'], businesses: ['*'] };
  const t = o => ev({ prueba: true, titulo: '[PRUEBA] Concierto de ensayo', requestId: 'p1', origen: { proveedor: 'prueba-claude', id_externo: 'x1', id_sesion: 's1' }, ...o });
  await assert.rejects(svc.prepareAdmission(t(), normal), /forbidden/);
  await assert.rejects(svc.prepareAdmission(t({ titulo: 'Concierto de ensayo' }), ing), /test_event_title_prefix/);
  await assert.rejects(svc.prepareAdmission(t({ origen: { proveedor: 'fever', id_externo: 'x1', id_sesion: 's1' } }), ing), /test_event_origin_prefix/);
  const prep = await svc.prepareAdmission(t(), ing); assert.equal(prep.admisible, true);
  const r = await svc.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento || t() }, ing);
  assert.equal(r.created, true); assert.equal(store.rows.get('eventos/' + r.eventId).data.prueba, true);
  // el mismo acceso crea eventos reales como siempre y el alfred normal no necesita admit_test
  assert.equal((await svc.prepareAdmission(ev({ requestId: 'real', prueba: false }), normal)).admisible, true);
});

test('checkedAt algo futuro (zona horaria) se ajusta a ahora; muy futuro se rechaza', () => {
  const f=new Date(Date.now()+2*3600000).toISOString();
  const r=_sources({fuentes:[{url:'https://example.org/e',checkedAt:f}]});
  assert.equal(r[0].checkedAt,null);
  assert.throws(()=>_sources({fuentes:[{url:'https://example.org/e',checkedAt:new Date(Date.now()+5*86400000).toISOString()}]}),/invalid_source_checkedAt/);
});

test('editar_evento: assetId:null (o image:null) quita la imagen; no se mezcla con una imagen nueva', async () => {
  const f = await fx();
  Object.assign(f.row(), { assetId: 'asset_cartel', image: 'https://cdn.example/cartel.jpg', imagen: 'https://cdn.example/cartel.jpg', sourceImageUrl: 'https://origen.example/cartel.jpg' });
  await assert.rejects(upd(f, { assetId: null, image: 'https://cdn.example/otra.jpg' }), /invalid_changes/);
  await assert.rejects(upd(f, { assetId: 'asset_otro', image: null }), /invalid_changes/);
  const v0 = f.row().version;
  await upd(f, { assetId: null });
  const r = f.row();
  assert.equal(r.version, v0 + 1);
  for (const k of ['assetId', 'image', 'imagen', 'sourceImageUrl']) assert.equal(r[k] ?? null, null, k);
  assert.equal(r.titulo, 'Concierto de ensayo'); assert.equal(r.fechaLocal, '2099-05-10');
  // image:null sobre otro evento con imagen
  const g = await fx(ev({ requestId: 'g1', titulo: 'Otro concierto de ensayo' }));
  Object.assign(g.row(), { assetId: 'asset_x', image: 'https://cdn.example/x.jpg', imagen: 'https://cdn.example/x.jpg' });
  await upd(g, { image: null });
  assert.equal(g.row().assetId ?? null, null); assert.equal(g.row().image ?? null, null);
});

// ---- 2.15.1: city/ubicacion/town, título acortado y descripción ----
import { parseChanges } from '../server-v2.mjs';
import { z } from 'zod';
import { tituloSoloForma } from '../event-domain.mjs';

test('editar city actualiza también town y ubicacion (antes se ignoraba en silencio) y acepta el título acortado', async () => {
  const f = await fx(ev({ titulo: 'Mercado Navideño de El Viso del Alcor', city: 'El Viso del Alcor', provincia: 'Sevilla' }));
  assert.equal(f.row().ubicacion, 'El Viso del Alcor'); assert.equal(f.row().town, 'El Viso del Alcor');
  const r = await upd(f, { city: 'El Viso', provincia: 'Córdoba', titulo: 'Mercado Navideño de El Viso' }, { evidenciaUrl: EV });
  assert.equal(r.city, 'El Viso'); assert.equal(f.row().city, 'El Viso'); assert.equal(f.row().town, 'El Viso'); assert.equal(f.row().ubicacion, 'El Viso');
  assert.equal(f.row().titulo, 'Mercado Navideño de El Viso'); assert.equal(f.row().nombre, 'Mercado Navideño de El Viso');
  assert.equal(f.row().provincia, 'Córdoba'); assert.equal(f.row().version, 2);
});

test('el título sigue rechazando un cambio de significado aunque cambie la ciudad', async () => {
  const f = await fx(ev({ titulo: 'Mercado Navideño de El Viso del Alcor', city: 'El Viso del Alcor' }));
  await assert.rejects(upd(f, { city: 'El Viso', titulo: 'Concierto de Navidad de El Viso' }, { evidenciaUrl: EV }), /title_meaning_changed/);
  assert.ok(tituloSoloForma('Mercado de El Viso del Alcor', 'Mercado de El Viso', ['El Viso del Alcor', 'El Viso']));
  assert.ok(!tituloSoloForma('Mercado de Almagro', 'Feria de Almagro', ['Almagro']));
});

test('editar descripcion cambia descripcion y su alias description', async () => {
  const f = await fx();
  const r = await upd(f, { descripcion: 'Descripción corregida con más detalle del evento.' });
  assert.equal(r.descripcion, 'Descripción corregida con más detalle del evento.');
  assert.equal(f.row().description, 'Descripción corregida con más detalle del evento.');
});

test('changesJson: acepta alias (description, nombre, town, ubicacion texto) y explica los campos no válidos', () => {
  const schema = z.object({ titulo: z.string().min(2), descripcion: z.string().min(2), city: z.string().min(2) }).partial().strict();
  assert.deepEqual(parseChanges('{"description":"Texto nuevo","nombre":"Título nuevo","town":"El Viso"}', schema), { descripcion: 'Texto nuevo', titulo: 'Título nuevo', city: 'El Viso' });
  assert.deepEqual(parseChanges('{"ubicacion":"Zas"}', schema), { city: 'Zas' });
  assert.throws(() => parseChanges('{"campo_raro":1}', schema), e => e.code === 'invalid_changes' && /campo_raro/.test(JSON.stringify(e.details.problemas)));
  assert.throws(() => parseChanges('{"city":"A","town":"B"}', schema), e => e.code === 'invalid_changes' && e.details.campo === 'city');
  assert.throws(() => parseChanges('no json', schema), e => e.code === 'invalid_changes' && /JSON/.test(e.details.ayuda));
});
