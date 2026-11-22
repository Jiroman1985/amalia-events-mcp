import test from 'node:test';
import assert from 'node:assert/strict';
import { causaDescarga } from '../media-store.mjs';
import { CATEGORIAS, VARIANTES, resolverValorCategoria } from '../catalogo-compartido.mjs';
import { DomainError } from '../event-domain.mjs';
import { diagnosticStage } from '../event-domain.mjs';

test('descarga de imagen: el motivo se clasifica sin exponer URLs ni mensajes remotos', () => {
  assert.equal(causaDescarga({ code: 'ENOTFOUND' }), 'dns');
  assert.equal(causaDescarga({ code: 'ECONNRESET' }), 'conexion');
  assert.equal(causaDescarga({ code: 'ENETUNREACH' }), 'conexion');
  assert.equal(causaDescarga({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'certificado');
  assert.equal(causaDescarga({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'certificado');
  assert.equal(causaDescarga(new Error('x')), 'red');
});

test('diagnosticStage conserva la causa de la descarga en el error devuelto', async () => {
  await assert.rejects(
    diagnosticStage('imagen_descarga', async () => { throw new DomainError('imagen_descarga_fallida', { causa: 'http_403', estadoHttp: 403 }); }),
    e => e.code === 'imagen_descarga_fallida' && e.details.causa === 'http_403' && e.details.etapa === 'imagen_descarga' && /causa/.test(e.details.ayuda)
  );
});

test('categorías: mayúsculas y tildes no importan y cada categoría oficial tiene sinónimos', () => {
  for (const v of ['musica', 'Música', 'MUSICA', 'música']) assert.equal(resolverValorCategoria(v).id, 'entretenimiento_y_cultura');
  assert.equal(CATEGORIAS.length, 8);
  for (const c of CATEGORIAS) assert.ok(Array.isArray(VARIANTES[c.id]) && VARIANTES[c.id].length > 0, c.id);
});
