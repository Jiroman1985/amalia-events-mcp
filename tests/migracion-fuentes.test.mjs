import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, mapearCabeceras, filaDeHoja, planificar, documentoNuevo, huecosPorCompletar } from '../migracion-fuentes.mjs';
import { filasExportacion, aCsv, COLUMNAS } from '../fuentes-export.mjs';
import { canonicalInputExtras, canonicalInput } from '../event-domain.mjs';

const CSV = `ID,Nombre,Tipo,Ámbito,CCAA,Provincia,Municipio,URL,Instagram,Frecuencia,Última revisión,Responsable,Estado,Notas,Columna rara
F-SAL-0001,Agenda Cultura CyL,agenda,CCAA,Castilla y León,,,https://www.culturacyl.es/agenda/?utm_source=x,,7,2026-11-10,Alfie,Activa,"Agenda, oficial",x
F-SAL-0002,Ayuntamiento de Ledesma,ayuntamiento,municipio,Castilla y León,Salamanca,Ledesma,https://ledesma.es/agenda,@ledesma,,,conchi,Activa,,
F-SAL-0003,Sin web,negocio,municipio,Castilla y León,Salamanca,Peñaranda,,,,,,,,
F-SAL-0004,Enlace compartido,agenda,municipio,Castilla y León,Salamanca,Béjar,https://share.google/AbC,,,,,,,
F-SAL-0005,Ledesma agenda duplicada,ayuntamiento,municipio,Castilla y León,Salamanca,Ledesma,http://ledesma.es/agenda/,,,,,,,
F-SAL-0002,Código repetido,otro,municipio,Castilla y León,Salamanca,Otro,https://otro.es/,,,,,,,
,Sin código,otro,municipio,Madrid,Madrid,Madrid,https://madrid.example/agenda,,,,,Bloqueada,Reutilización prohibida,
`;
const reg = [
  { id: 'fte_web_cyl00000000000000000001', data: { nombre_entidad: 'Agenda Cultura Castilla y León', canal: 'web', url: 'https://culturacyl.es/agenda', identificador: 'culturacyl.es/agenda', via: 'Referencia F-XXX-0024 del listado antiguo', provincia: null, estado: 'descubierta' } },
  { id: 'fte_web_solo0000000000000000002', data: { nombre_entidad: 'Solo en el MCP', canal: 'web', url: 'https://soloenmcp.es/', identificador: 'soloenmcp.es' } },
  { id: 'fte_ig_sinurl000000000000000003', data: { nombre_entidad: 'Perfil sin url', canal: 'correo', identificador: 'a@b.es' } }
];
const preparar = () => { const [cab, ...v] = parseCsv(CSV); const m = mapearCabeceras(cab); return { m, filas: v.map((x, i) => filaDeHoja(x, m.mapa, i + 2)) }; };

test('csv con comillas y cabeceras con alias: mapea y detecta columnas sin mapear', () => {
  const { m, filas } = preparar();
  assert.deepEqual(m.sinMapear, ['Columna rara']); assert.equal(m.mapa.codigo, 0); assert.equal(m.mapa.ccaa, 4);
  assert.equal(filas.length, 7); assert.equal(filas[0].notas, 'Agenda, oficial'); assert.equal(filas[0].urlClave, 'culturacyl.es/agenda'); assert.equal(filas[0].ultimaRevision, '2026-11-10T00:00:00.000Z');
  assert.equal(filas[0].responsable, 'alfie'); assert.equal(filas[3].sinResolver, true); assert.equal(filas[6].estado, 'bloqueada');
});

test('informe de ensayo: importar, fusionar, conflictos (F-SAL-0001 vs F-XXX-0024), sin URL, share.google y códigos repetidos', () => {
  const { m, filas } = preparar(); const { informe, plan, huella } = planificar({ filas, registro: reg, cabeceras: { sinMapear: m.sinMapear } });
  const r = informe.resumen;
  assert.equal(r.filasHoja, 7); assert.equal(r.registroMcp, 3);
  assert.equal(r.seFusionanConRegistro, 1); assert.equal(informe.fusionarConRegistro[0].fuenteId, 'fte_web_cyl00000000000000000001');
  assert.equal(informe.fusionarEntreFilasHoja.length, 1); assert.deepEqual(informe.fusionarEntreFilasHoja[0].filas.map(f => f.codigo), ['F-SAL-0002', 'F-SAL-0005']);
  const cod = informe.conflictos.find(c => c.tipo === 'codigo_distinto_en_registro'); assert.equal(cod.codigoHoja, 'F-SAL-0001'); assert.deepEqual(cod.codigosRegistro, ['F-XXX-0024']);
  assert.ok(informe.nombresDistintos.some(c => c.codigo === 'F-SAL-0001')); // «CyL» vs «Castilla y León»: se deja a revisión humana
  assert.equal(r.sinUrl, 1); assert.equal(informe.sinUrl[0].codigo, 'F-SAL-0003'); assert.equal(r.enlacesSinResolver, 1); assert.equal(informe.enlacesSinResolver[0].codigo, 'F-SAL-0004');
  assert.equal(r.codigosDuplicadosEnHoja, 1); assert.equal(informe.codigosDuplicadosEnHoja[0].codigo, 'F-SAL-0002'); assert.equal(r.sinCodigo, 1);
  assert.deepEqual(informe.codigosReasignados.map(x => [x.antes, x.despues]), [['F-SAL-0002', 'F-SAL-0006']]);
  assert.equal(r.registroSinUrl, 1); assert.equal(r.seImportan, plan.filter(p => p.accion === 'crear').length);
  assert.match(huella, /^[0-9a-f]{16}$/); assert.equal(planificar({ filas, registro: reg }).huella, huella); // determinista
});

test('el plan no escribe: planificar es puro y las fusiones solo rellenan huecos sin pisar valores ni el código existente', () => {
  const { filas } = preparar(); const { plan } = planificar({ filas, registro: reg });
  const fus = plan.find(p => p.accion === 'fusionar'); const d = { ...reg[0].data, codigo: 'F-XXX-0024', tipo: 'agenda', responsable: 'conchi' };
  const set = huecosPorCompletar(d, fus.filas);
  assert.equal('codigo' in set, false); assert.equal('tipo' in set, false); assert.equal('responsable' in set, false);
  assert.deepEqual(set.codigos_alternativos, ['F-SAL-0001']); assert.equal(set.ultima_revision, '2026-11-10T00:00:00.000Z'); assert.equal('url_normalizada' in set, false); // la hoja no decide la URL normalizada de una fuente existente
});

test('documento nuevo: conserva el F-XXX-0000, estado, bloqueo y marca los enlaces sin resolver como pausada; sin URL usa id estable por código', () => {
  const { filas } = preparar(); const ahora = '2026-11-21T10:00:00.000Z';
  const sin = documentoNuevo([filas[2]], { ahora }); assert.equal(sin.id.startsWith('fte_hoja_'), true); assert.equal(sin.data.codigo, 'F-SAL-0003'); assert.equal(sin.id, documentoNuevo([filas[2]], { ahora }).id);
  const share = documentoNuevo([filas[3]], { ahora }); assert.equal(share.data.estado, 'pausada'); assert.match(share.data.notas, /share\.google/);
  const bloq = documentoNuevo([filas[6]], { ahora }); assert.equal(bloq.data.estado, 'bloqueada'); assert.equal(bloq.data.motivo_bloqueo.texto, 'Reutilización prohibida');
  const web = documentoNuevo([filas[1], filas[4]], { ahora }); assert.match(web.id, /^fte_web_[0-9a-f]{24}$/); assert.equal(web.data.url_normalizada, 'ledesma.es/agenda'); assert.deepEqual(web.data.codigos_alternativos, ['F-SAL-0005']); assert.equal(web.data.creada_por, 'migracion');
});

test('exportación a hoja: columnas fijas, sin fusionadas, ordenada por código, CSV escapado', () => {
  const f = filasExportacion([{ id: 'fte_a', data: { codigo: 'F-SAL-0002', nombre_entidad: 'Con "comillas", y coma', url: 'https://a.es/', estado: 'activa', responsable: 'alfie', ultima_revision: null } }, { id: 'fte_b', data: { codigo: 'F-SAL-0001', nombre_entidad: 'B', estado: 'fusionada' } }, { id: 'fte_c', data: { codigo: 'F-SAL-0001', nombre_entidad: 'C', estado: 'bloqueada', motivo_bloqueo: { texto: 'licencia', licenciaUrl: 'https://l.es/' } } }], Date.parse('2026-11-21T10:00:00Z'));
  assert.deepEqual(f[0], COLUMNAS); assert.equal(f.length, 3); assert.equal(f[1][1], 'F-SAL-0001'); assert.equal(f[1][COLUMNAS.indexOf('Licencia')], 'https://l.es/'); assert.equal(f[2][COLUMNAS.indexOf('Vencida')], 'sí');
  assert.match(aCsv(f), /"Con ""comillas"", y coma"/);
});

test('altas: el evento guarda fuenteId (fte_… o F-XXX-0000) y se rechaza un valor inventado', () => {
  assert.equal(canonicalInputExtras({ fuenteId: ' F-SAL-0001 ' }).fuenteId, 'F-SAL-0001');
  assert.equal(canonicalInputExtras({ fuenteId: 'fte_web_0123456789abcdef01234567' }).fuenteId, 'fte_web_0123456789abcdef01234567');
  assert.throws(() => canonicalInputExtras({ fuenteId: 'la-web-del-ayuntamiento' }), /invalid_source_id/);
  const e = canonicalInput({ negocioId: 'b', titulo: 'Concierto de prueba', descripcion: 'Descripción', city: 'Ledesma', fechaLocal: '2027-01-10', fuentes: [{ url: 'https://ledesma.es/a' }], fuenteId: 'F-SAL-0002' });
  assert.equal(e.fuenteId, 'F-SAL-0002');
});

const CSV2 = `ID,Provincia,CCAA,Municipio,Nombre negocio/entidad,Tipo,URL,Estado,Notas
F-MAL-0048,Málaga,Andalucía,Antequera,Torcal de Antequera,negocio local,https://torcal.example/visitas/,activa,
F-MAL-0360,Málaga,Andalucía,Antequera,Torcal de Antequera,Organizador,https://torcal.example/visitas/,descartada (duplicado),"MCP fte_instagram_13b90069ef0dde1a7f0cb67a
20nov2026 fusionada documentalmente en F-MAL-0048 por encargo"
F-PON-0033,Galicia,,Gondomar,Taquilla Concello de Gondomar,taquilla,https://taquilla.example/,descubierta,fte_web_9a95820db9cf522091ad6e0b
F-SAL-0130,Salamanca,,Salamanca,Castilla y León es Vida,Particular,http://www.turismo.example/,restringida,fte_instagram_46de3c7d7ae32d8766c632f9
`;
const reg2 = [
  { id: 'fte_web_torcal00000000000000001', data: { nombre_entidad: 'Portal torcal', canal: 'web', url: 'https://torcal.example/visitas', identificador: 'torcal.example/visitas', provincia: 'Málaga', estado: 'descubierta' } },
  { id: 'fte_instagram_13b90069ef0dde1a7f0cb67a', data: { nombre_entidad: 'Torcal de Antequera', canal: 'instagram', url: 'https://www.instagram.com/torcal_de_antequera/', identificador: 'torcal_de_antequera', provincia: 'Málaga', estado: 'descubierta' } },
  { id: 'fte_web_9a95820db9cf522091ad6e0b', data: { nombre_entidad: 'Taquilla Gondomar', canal: 'web', url: 'https://taquilla.example', identificador: 'taquilla.example', provincia: 'Pontevedra', estado: 'descubierta' } },
  { id: 'fte_instagram_46de3c7d7ae32d8766c632f9', data: { nombre_entidad: 'Castilla y León es Vida', canal: 'instagram', url: 'https://www.instagram.com/cylesvida/', identificador: 'cylesvida', provincia: 'Salamanca', estado: 'descubierta' } },
  { id: 'fte_web_otroportal0000000000004', data: { nombre_entidad: 'Portal turismo', canal: 'web', url: 'https://turismo.example', identificador: 'turismo.example', provincia: 'Soria', estado: 'descubierta' } }
];
test('el ID del MCP en Notas manda sobre la URL: una fila alias con URL sobrescrita no se funde con la canónica ni genera conflicto', () => {
  const [cab, ...v] = parseCsv(CSV2); const m = mapearCabeceras(cab); const filas = v.map((x, i) => filaDeHoja(x, m.mapa, i + 2));
  assert.deepEqual(filas[1].idsMcp, ['fte_instagram_13b90069ef0dde1a7f0cb67a']); assert.equal(filas[1].aliasDe, 'F-MAL-0048');
  const { informe, plan } = planificar({ filas, registro: reg2 });
  const alias = plan.find(p => p.fuenteId === 'fte_instagram_13b90069ef0dde1a7f0cb67a'); assert.equal(alias.por, 'id_mcp_en_notas');
  assert.equal(plan.find(p => p.fuenteId === 'fte_web_torcal00000000000000001').por, 'url');
  assert.deepEqual(informe.aliasDocumentales, [{ fuenteId: 'fte_instagram_13b90069ef0dde1a7f0cb67a', codigo: 'F-MAL-0360', duplicadoDe: 'F-MAL-0048' }]);
  assert.equal(informe.conflictos.length, 0, JSON.stringify(informe.conflictos)); // «Galicia» en Provincia es la CCAA; Salamanca coincide con su perfil de Instagram
  assert.equal(informe.resumen.emparejadasPor.id_mcp_en_notas, 3);
  const set = huecosPorCompletar(reg2[1].data, alias.filas); assert.equal(set.codigo, 'F-MAL-0360'); assert.equal(set.estado, 'descartada'); assert.equal(set.duplicado_de, 'F-MAL-0048');
  const bloq = huecosPorCompletar(reg2[3].data, plan.find(p => p.fuenteId === reg2[3].id).filas); assert.equal(bloq.estado, 'bloqueada'); assert.ok(bloq.motivo_bloqueo.texto);
  assert.equal(huecosPorCompletar({ ...reg2[3].data, estado: 'activa' }, plan.find(p => p.fuenteId === reg2[3].id).filas).estado, undefined); // no degrada
});

import { urlNormalizadaCorrecta, planReparacionUrl } from '../reparacion-url.mjs';
test('reparación de url_normalizada: Instagram debe ser instagram.com/<usuario>; web solo se corrige si cambia el dominio; sin valor guardado no se toca', () => {
  const ig = { canal: 'instagram', url: 'https://www.instagram.com/radioagueda/', url_normalizada: 'noticiasciudadrodrigo.com' };
  assert.equal(urlNormalizadaCorrecta(ig), 'instagram.com/radioagueda'); assert.equal(urlNormalizadaCorrecta({ ...ig, url_normalizada: 'instagram.com/radioagueda' }), null); assert.equal(urlNormalizadaCorrecta({ ...ig, url_normalizada: undefined }), null);
  assert.equal(urlNormalizadaCorrecta({ canal: 'web', url: 'https://algarrobo.es', url_normalizada: 'facebook.com/aytoalgarrobo' }), 'algarrobo.es');
  assert.equal(urlNormalizadaCorrecta({ canal: 'web', url: 'https://lasalina.es/agenda.html', url_normalizada: 'lasalina.es/agenda.html?area=cultura' }), null); // parámetro de identidad legítimo
  const plan = planReparacionUrl([{ id: 'a', data: ig, updateTime: '1' }, { id: 'b', data: { ...ig, url_normalizada: 'instagram.com/radioagueda' } }, { id: 'c', data: { canal: 'web', url: 'https://algarrobo.es', url_normalizada: 'facebook.com/x' } }]);
  assert.equal(plan.total, 2); assert.deepEqual(plan.porCanal, { instagram: 1, web: 1 }); assert.equal(planReparacionUrl([{ id: 'a', data: ig }, { id: 'c', data: { canal: 'web', url: 'https://algarrobo.es', url_normalizada: 'facebook.com/x' } }], 'c').total, 1);
});
