import test from 'node:test';
import assert from 'node:assert/strict';
import { claveOrganizador, crearLead, listarLeads } from '../negocio-lead.mjs';

const P = { id: 'alfred', businesses: ['*'], actions: ['create_business', 'read'] };
const principal = { ...P, can: () => true };
function fakeStore() {
  const m = new Map();
  return { m,
    async get(c, k) { const d = m.get(c + '/' + k); return d ? { id: k, data: d } : null; },
    async write(c, k, d) { m.set(c + '/' + k, d); },
    async list(c, { estado, business } = {}) { return [...m].filter(([k]) => k.startsWith(c + '/')).map(([k, d]) => ({ id: k.split('/')[1], data: d })).filter(r => (!estado || r.data.estado === estado) && (!business || r.data.negocioId === business)); } };
}
const T = { url: 'https://bibliocanizaresypuentevadillos.blogspot.com/2026/11/taller.html' };
const mk = (st, nombre, provincia) => crearLead(st, { nombre, provincia, fuenteTercero: T }, principal);

test('la clave ignora tildes, signos y formas jurídicas', () => {
  assert.equal(claveOrganizador('Asociación Vecinal El Sotillo'), claveOrganizador('AAVV el Sotillo'));
  assert.equal(claveOrganizador('asociacion vecinal el sotillo'), claveOrganizador('Asociación Vecinal «El Sotillo»'));
});
test('tres variantes del nombre en la misma provincia → un único lead; otra provincia → otro', async () => {
  const st = fakeStore();
  const a = await mk(st, 'Asociación Vecinal El Sotillo', 'Cuenca'), b = await mk(st, 'AAVV el Sotillo', 'Cuenca'), c = await mk(st, 'asociacion vecinal el sotillo', 'cuenca');
  assert.equal(a.created, true); assert.equal(b.negocioId, a.negocioId); assert.equal(c.negocioId, a.negocioId); assert.equal(b.alreadyCreated, true);
  const d = await mk(st, 'Asociación Vecinal El Sotillo', 'Badajoz');
  assert.notEqual(d.negocioId, a.negocioId);
  const row = st.m.get('negocios/' + a.negocioId);
  assert.equal(row.estado, 'lead'); assert.equal(row.visible, false); assert.equal(row.canalPropio, false); assert.equal(row.fuentesTercero[0].url, T.url);
});
test('exige fuente de tercero, provincia y nombre válido', async () => {
  const st = fakeStore();
  await assert.rejects(crearLead(st, { nombre: 'Club Lector', provincia: 'Cuenca' }, principal), /source_required/);
  await assert.rejects(crearLead(st, { nombre: 'Club Lector', fuenteTercero: T }, principal), /lead_provincia_requerida/);
  await assert.rejects(crearLead(st, { nombre: 'Asociación', provincia: 'Cuenca', fuenteTercero: T }, principal), /lead_nombre_invalido/);
  await assert.rejects(crearLead(st, { nombre: 'Club Lector', provincia: 'Cuenca', fuenteTercero: { url: 'http://x.es/a' } }, principal));
});
test('listar_negocios_lead cuenta eventos no retirados y filtra por mínimo y provincia', async () => {
  const st = fakeStore();
  const a = await mk(st, 'Asociación El Sotillo', 'Cuenca'), b = await mk(st, 'Club Lector Norte', 'Cuenca');
  for (let i = 0; i < 3; i++) st.m.set('eventos/e' + i, { negocioId: a.negocioId, city: 'Cañizares', retirado: i === 2 });
  for (let i = 3; i < 6; i++) st.m.set('eventos/e' + i, { negocioId: a.negocioId, city: 'Cañizares' });
  st.m.set('eventos/z', { negocioId: b.negocioId, city: 'Cuenca' });
  let r = await listarLeads(st, { minEventos: 3 }, principal);
  assert.deepEqual(r.leads.map(l => [l.nombre, l.eventos]), [['Asociación El Sotillo', 5]]);
  r = await listarLeads(st, { minEventos: 1, provincia: 'Badajoz' }, principal);
  assert.equal(r.leads.length, 0);
});
