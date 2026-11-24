import test from 'node:test';
import assert from 'node:assert/strict';
import { registryCutoffConfig, REGISTRY_CUTOFF_DEFAULT, cutoffValue } from '../registro-provenance.mjs';

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
test('un corte presente pero mal formado sigue fallando cerrado', () => {
  const c = registryCutoffConfig(undefined, 'mañana', () => {});
  assert.throws(() => cutoffValue(c.cutoff), /registro_cutoff_unconfigured/);
  assert.throws(() => cutoffValue(registryCutoffConfig('', undefined, () => {}).cutoff), /registro_cutoff_unconfigured/);
});
