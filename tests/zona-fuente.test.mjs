import test from 'node:test';
import assert from 'node:assert/strict';
import { registrarFuente } from '../registro-fuentes.mjs';
import { deducirZona, reconocerZona, PROVINCIAS } from '../territorio.mjs';

const writer = { id: 'alfie', actions: ['admit', 'read', 'register_source'], businesses: ['*'] };
class Store {
  constructor(seed = []) { this.docs = new Map(seed.map(r => [r.id, { id: r.id, data: r.data, updateTime: '1' }])); this.writes = []; }
  async get(c, id) { return this.docs.get(id) || null; }
  async list(c, { cursor, limit = 500 } = {}) { return [...this.docs.values()].filter(r => !cursor || r.id > cursor).slice(0, limit); }
  async listAll() { return [...this.docs.values()]; }
  async write(c, id, data) { this.writes.push({ c, id, data }); this.docs.set(id, { id, data, updateTime: '2' }); return {}; }
}
const base = { canal: 'web', url: 'https://www.entradium.com/es/bodega-toro', nombreEntidad: 'Bodega de Toro (Entradium)', via: 'Ficha de la plataforma de entradas enlazada desde la web de la bodega' };
const code = p => p.then(() => null, e => e);

test('Entradium en Toro (Zamora): sin zona explícita y ámbito comarcal se rechaza con un error claro que dice el campo y los valores', async () => {
  const e = await code(registrarFuente(new Store(), { ...base, municipio: 'Toro', ambito: 'comarca' }, writer));
  assert.equal(e.code, 'fuente_ambito_sin_zona');
  assert.equal(e.details.campoFaltante, 'region o provincia');
  assert.ok(e.details.valoresAceptados.provincias.includes('Zamora')); assert.ok(e.details.valoresAceptados.regiones.includes('Castilla y León'));
  assert.match(e.details.ayuda, /provincia/);
});

test('con provincia Zamora la región Castilla y León se completa sola', async () => {
  const s = new Store(); const r = await registrarFuente(s, { ...base, municipio: 'Toro', ambito: 'comarca', provincia: 'zamora' }, writer);
  assert.equal(r.registrada, true); const d = s.writes[0].data;
  assert.equal(d.provincia, 'Zamora'); assert.equal(d.region, 'Castilla y León');
});

test('la zona se deduce del municipio si otra fuente ya registrada lo sitúa; si el municipio es una provincia, también', async () => {
  const seed = [{ id: 'fte_web_x', data: { municipio: 'Toro', provincia: 'Zamora', region: 'Castilla y León', canal: 'web', identificador: 'otra.es', nombre_entidad: 'Ayto Toro' } }];
  const s = new Store(seed); const r = await registrarFuente(s, { ...base, municipio: 'Toro', ambito: 'comarca' }, writer);
  assert.equal(r.registrada, true); assert.equal(r.zonaDeducida.provincia, 'Zamora'); assert.match(r.zonaDeducida.porque, /otra fuente/);
  const s2 = new Store(); const r2 = await registrarFuente(s2, { ...base, url: 'https://www.entradium.com/es/zamora', nombreEntidad: 'Entradium Zamora', municipio: 'Zamora', ambito: 'provincia' }, writer);
  assert.equal(r2.registrada, true); assert.equal(r2.zonaDeducida.region, 'Castilla y León');
});

test('ámbito municipio sigue sin exigir zona; sin municipio ni zona en otro ámbito da el error claro', async () => {
  const s = new Store(); assert.equal((await registrarFuente(s, { ...base, municipio: 'Toro' }, writer)).registrada, true);
  const e = await code(registrarFuente(new Store(), { ...base, ambito: 'nacional' }, writer));
  assert.equal(e.code, 'fuente_ambito_sin_zona'); assert.equal(e.details.municipioRecibido, null);
});

test('territorio: alias y valores aceptados', () => {
  assert.equal(reconocerZona('Orense').provincia, 'Ourense'); assert.equal(reconocerZona('Castilla y León').tipo, 'region');
  assert.equal(PROVINCIAS.length >= 50, true); assert.equal(deducirZona({ municipio: 'Toro', filas: [] }), null);
});
