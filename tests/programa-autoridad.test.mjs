import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgramAdmission } from '../program-admission.mjs';
import { escanearDuplicados } from '../dedup_amalia.mjs';

const prog = new ProgramAdmission({}, { capture: { capture: async () => { throw Error('no debe capturar nada'); } } });
const rechazo = async p => prog.load(p, { data: {} }).then(() => null, e => e);

test('caso Tierra de Vinos en Manzanares: un organizador municipal no es una autoridad soportada y el error dice qué hacer', async () => {
  const e = await rechazo({ url: 'https://manzanares.es/catas-tierra-de-vinos', directorioUrl: 'https://manzanares.es/directorio', enlaceInstitucionalUrl: 'https://manzanares.es/' });
  assert.equal(e.code, 'authority_directory_unsupported');
  assert.equal(e.details.recibido, 'https://manzanares.es/directorio'); assert.match(e.details.autoridadSoportada, /Universidad de Salamanca/); assert.match(e.details.directorioUrlDebeEmpezarPor, /educa\.jcyl\.es/);
  assert.equal(e.details.alternativa, 'preparar_admision'); assert.match(e.details.ayuda, /ayuntamiento/); assert.match(e.details.ayuda, /UNA llamada por sesión/);
});

test('directorio con la ruta soportada pero universidad inválida (mayúsculas o símbolos): mismo error claro', async () => {
  const e = await rechazo({ url: 'https://usal.es/p', directorioUrl: 'https://www.educa.jcyl.es/universidad/es/directorio-universidades/universidades-castilla-leon/Universidad_X?q=1', enlaceInstitucionalUrl: 'https://usal.es/s' });
  assert.equal(e.code, 'authority_directory_unsupported'); assert.ok(e.details.directorioUrlDebeTerminarEn);
});

test('faltan campos de procedencia: el error lista cuáles y la alternativa', async () => {
  const e = await rechazo({ url: 'https://manzanares.es/catas' });
  assert.equal(e.code, 'program_provenance_required'); assert.deepEqual(e.details.faltan, ['directorioUrl', 'enlaceInstitucionalUrl']); assert.equal(e.details.alternativa, 'preparar_admision');
  assert.deepEqual((await rechazo(null)).details.faltan, ['url', 'directorioUrl', 'enlaceInstitucionalUrl']);
});

test('alternativa: cuatro catas de la misma página (27-28 nov, 1 €) se admiten por la vía ordinaria; un duplicado exacto sigue bloqueando', () => {
  const url = 'https://manzanares.es/catas-tierra-de-vinos', base = { negocioId: 'b', city: 'Manzanares', lugar: 'Museo Etnográfico', fuentes: [{ url }] };
  const catas = [['Cata de vinos blancos', '2026-11-27', '19:00'], ['Cata de vinos tintos', '2026-11-27', '21:00'], ['Cata de vinos rosados', '2026-11-28', '12:00'], ['Cata de espumosos', '2026-11-28', '19:00']].map(([titulo, fechaLocal, horaLocal], i) => ({ ...base, titulo, fechaLocal, horaLocal, sesionId: 'cata-' + (i + 1) }));
  const existentes = [];
  for (const c of catas) { const r = escanearDuplicados(c, existentes); assert.deepEqual(r.coincidencias, [], c.titulo); existentes.push({ id: 'ev_' + c.sesionId, data: { ...c, fuentes: [{ url }] } }); }
  assert.equal(escanearDuplicados(catas[0], existentes).coincidencias.length, 1);
});
