import test from 'node:test';
import assert from 'node:assert/strict';
import { agenteCanonico, conIdentidad, esAgente, AGENTES } from '../identidad.mjs';
import { authenticate } from '../server-v2.mjs';
import { hash, record, canonicalInput } from '../event-domain.mjs';
import { publicar, responder, listar, misPendientes, decidirHilo, esAdminTablon } from '../tablon.mjs';
import { publicarTarea } from '../tareas.mjs';
import { registrarFuente, actualizarFuente } from '../registro-fuentes.mjs';
import { marcarRevisada, listarVencidas, resumenFuentes } from '../fuentes-consultas.mjs';
import { listarZonas, asignarZona, asignarZonasLote, reasignarFuentesZona, repartirFuentes, resolverAgente, ubicacionDe, claveZona, nombreZona } from '../zonas.mjs';
import { planificarIdentidades } from '../migracion-identidades.mjs';
import { FirestoreStore } from '../firestore-store.mjs';

class Store {
  constructor(seed = []) { this.docs = new Map(seed.map(r => [r.col + '/' + r.id, { id: r.id, data: r.data, updateTime: '1' }])); this.writes = []; this.n = 1; }
  async get(c, id) { const r = this.docs.get(c + '/' + id); return r ? { id, data: structuredClone(r.data), updateTime: r.updateTime } : null; }
  async list(c, { cursor, limit = 500 } = {}) { return [...this.docs].filter(([k]) => k.startsWith(c + '/')).map(([, r]) => r).sort((a, b) => (a.id < b.id ? -1 : 1)).filter(r => !cursor || r.id > cursor).slice(0, limit).map(r => ({ id: r.id, data: structuredClone(r.data), updateTime: r.updateTime })); }
  async write(c, id, data, o = {}) {
    const k = c + '/' + id, cur = this.docs.get(k);
    if ((o.create && cur) || (!o.create && cur && o.updateTime !== cur.updateTime)) { const e = new Error('version_conflict'); e.code = 'version_conflict'; throw e; }
    this.writes.push({ c, id, create: !!o.create }); this.docs.set(k, { id, data: structuredClone(data), updateTime: String(++this.n) }); return {};
  }
}
const P = (id, actions) => ({ id, actions, businesses: ['*'] });
const code = p => p.then(() => null, e => e.code);
let reloj = 0; const now = () => new Date(Date.UTC(2026, 10, 21, 10, 0, reloj++)).toISOString();

test('mapa de alias: alfred-altas→alfred, amalia-asistente→amalia; lola y susan preparadas; el resto es su propio agente', () => {
  assert.equal(agenteCanonico('alfred-altas'), 'alfred'); assert.equal(agenteCanonico('Alfred-Ediciones'), 'alfred'); assert.equal(agenteCanonico('amalia-asistente'), 'amalia');
  assert.equal(agenteCanonico('lola-operator'), 'lola'); assert.equal(agenteCanonico('lola'), 'lola'); assert.equal(agenteCanonico('susan'), 'susan'); assert.equal(agenteCanonico('conchi-owner'), 'conchi');
  for (const a of ['conchi', 'alfie', 'hark', 'amalia', 'alfred']) assert.equal(agenteCanonico(a), a);
  assert.equal(agenteCanonico('claude-ingesta'), 'claude-ingesta'); assert.equal(esAgente('claude-ingesta'), false); assert.ok(AGENTES.includes('susan') && AGENTES.includes('lola'));
});

test('autenticación: cada token se resuelve a su agente canónico y conserva el principal original (id intacto: recibos e idempotencia)', () => {
  const token = 'token-de-prueba-alfred-altas', registry = [{ id: 'alfred-altas', tokenHash: hash(token), actions: ['board'], businesses: ['*'] }, { id: 'amalia-asistente', tokenHash: hash('t2'), actions: ['read'], businesses: ['*'] }];
  const p = authenticate('Bearer ' + token, registry); assert.equal(p.agente, 'alfred'); assert.equal(p.principalOriginal, 'alfred-altas'); assert.equal(p.id, 'alfred-altas');
  assert.equal(authenticate('Bearer t2', registry).agente, 'amalia'); assert.equal(authenticate('Bearer otro', registry), null);
  assert.equal(conIdentidad(null), null);
});

test('permisos: Alfred decide con cualquiera de sus tokens (con board); el resto no; Lola con board lee y escribe pero no decide', async () => {
  const s = new Store(), alfredAltas = conIdentidad(P('alfred-altas', ['board'])), alfredEd = conIdentidad(P('alfred-ediciones', ['read', 'edit', 'board'])), lola = conIdentidad(P('lola', ['read', 'board'])), alfie = conIdentidad(P('alfie', ['board'])), sinBoard = conIdentidad(P('alfred-x', ['read']));
  assert.equal(esAdminTablon(alfredAltas), true); assert.equal(esAdminTablon(alfredEd), true); assert.equal(esAdminTablon(lola), false); assert.equal(esAdminTablon(alfie), false);
  assert.equal(esAdminTablon(conIdentidad(P('alfred', ['read']))), true); // Alfred decide con cualquier token (permiso derivado del agente)
  assert.equal(esAdminTablon(sinBoard), false); // otro agente sin board no
  const d = await publicar(s, { tipo: 'duda', asunto: 'Una duda', texto: 'x' }, lola, { now });
  assert.equal((await decidirHilo(s, { hilo: d.hilo, decision: 'Hazlo así' }, alfredAltas, { now })).decidido, true);
  const e = await publicar(s, { tipo: 'duda', asunto: 'Otra duda', texto: 'x' }, alfie, { now });
  assert.equal(await code(decidirHilo(s, { hilo: e.hilo, decision: 'x' }, lola)), 'forbidden');
  assert.equal(await code(asignarZona(s, { zona: 'Madrid', agente: 'alfie', motivo: 'reparto' }, lola)), 'forbidden');
  assert.equal((await asignarZona(s, { zona: 'Madrid', agente: 'alfie', motivo: 'reparto inicial' }, alfredEd, { now })).asignada, true);
});

test('tablón: un mismo agente con varios tokens sale con UN nombre (autor, agente y destinatarios) y el principal original queda aparte', async () => {
  const s = new Store(), a1 = conIdentidad(P('alfred-altas', ['board'])), a2 = conIdentidad(P('alfred', ['board'])), am = conIdentidad(P('amalia-asistente', ['board'])), c = conIdentidad(P('conchi', ['board']));
  const r = await publicar(s, { tipo: 'aviso', asunto: 'Aviso de prueba', texto: 'x', destinatarios: ['alfred-altas', 'amalia-asistente', 'alfred'] }, c, { now });
  assert.deepEqual(s.docs.get('tablon_agentes/' + r.id).data.destinatarios, ['alfred', 'amalia']);
  const m1 = await responder(s, { hilo: r.hilo, texto: 'Desde un token' }, a1, { now }), m2 = await responder(s, { hilo: r.hilo, texto: 'Desde el otro' }, a2, { now }), m3 = await responder(s, { hilo: r.hilo, texto: 'AMALia' }, am, { now });
  for (const m of [m1, m2]) { const d = s.docs.get('tablon_agentes/' + m.id).data; assert.equal(d.autor, 'alfred'); assert.equal(d.agente, 'alfred'); }
  assert.equal(s.docs.get('tablon_agentes/' + m1.id).data.principal, 'alfred-altas'); assert.equal(s.docs.get('tablon_agentes/' + m2.id).data.principal, 'alfred'); assert.equal(s.docs.get('tablon_agentes/' + m3.id).data.autor, 'amalia');
  const conv = await listar(s, { hilo: r.hilo }, c); assert.deepEqual([...new Set(conv.mensajes.map(x => x.agente))].sort(), ['alfred', 'amalia', 'conchi']);
  assert.equal((await misPendientes(s, a1)).agente, 'alfred'); assert.equal((await misPendientes(s, a2)).agente, 'alfred');
  const t = await publicarTarea(s, { titulo: 'Tarea de Alfred' }, a1, { now }); assert.equal(t.agente, 'alfred'); assert.equal(s.docs.get('tareas_agentes/' + t.tareaId).data.creada_por_principal, 'alfred-altas');
});

test('lectura robusta: documentos antiguos con alias se ven ya con el agente canónico', async () => {
  const s = new Store([{ col: 'tablon_agentes', id: 'msg_antiguo', data: { id: 'msg_antiguo', hilo: 'msg_antiguo', es_raiz: true, autor: 'alfred-altas', agente: 'alfred-altas', tipo: 'aviso', asunto: 'Antiguo', texto: 'x', destinatarios: ['amalia-asistente'], prioridad: 'normal', estado: 'abierto', creado_en: '2026-11-20T10:00:00Z' } }]);
  const ahora = { now: () => '2026-11-20T10:30:00Z' };   // el autocierre usa el reloj: dentro de las 6 h del aviso
  const l = await listar(s, {}, conIdentidad(P('amalia-asistente', ['board'])), ahora); assert.equal(l.hilos[0].autor, 'alfred'); assert.deepEqual(l.hilos[0].destinatarios, ['amalia']); assert.equal((await misPendientes(s, conIdentidad(P('amalia', ['board'])), ahora)).total, 1);
});

test('fuentes y altas: responsable, creada_por y revisiones usan el canónico; el principal queda en *_principal; los eventos añaden agenteCanonico', async () => {
  const s = new Store(), alt = conIdentidad(P('alfred-altas', ['read', 'register_source'])), ami = conIdentidad(P('amalia-asistente', ['read', 'register_source']));
  const r = await registrarFuente(s, { canal: 'web', url: 'https://x.es/agenda', nombreEntidad: 'Ayuntamiento X', municipio: 'Ledesma', provincia: 'Salamanca', via: 'Web oficial del ayuntamiento' }, alt, { now });
  const d = s.docs.get('registro_fuentes/' + r.fuenteId).data; assert.equal(d.responsable, 'alfred'); assert.equal(d.creada_por, 'alfred'); assert.equal(d.creada_por_principal, 'alfred-altas'); assert.equal(d.modificada_por, 'alfred'); assert.match(d.via, /^\[alfred\]/);
  assert.equal((await marcarRevisada(s, { fuenteId: r.fuenteId, eventosNuevos: 1 }, ami, { now })).revisadaPor, 'amalia');
  const u = await actualizarFuente(s, { fuenteId: r.fuenteId, responsable: 'amalia-asistente', motivo: 'Cambio de responsable' }, alt, { now }); assert.equal(u.actualizada, true);
  const d2 = s.docs.get('registro_fuentes/' + r.fuenteId).data; assert.equal(d2.responsable, 'amalia'); assert.equal(d2.historial.at(-1).por, 'alfred'); assert.equal(d2.historial.at(-1).principal, 'alfred-altas');
  assert.equal((await listarVencidas(s, { responsable: 'yo' }, conIdentidad(P('amalia', ['read'])), { ahora: Date.now() + 10 * 86400000 })).total, 1);
  const legacy = new Store([{ col: 'registro_fuentes', id: 'fte_web_a', data: { responsable: 'alfred-altas', estado: 'activa', canal: 'web' } }, { col: 'registro_fuentes', id: 'fte_web_b', data: { responsable: 'alfred', estado: 'activa', canal: 'web' } }]);
  assert.deepEqual((await resumenFuentes(legacy, {}, P('x', ['read']))).porResponsable, [{ clave: 'alfred', total: 2 }]);
  const ev = record(canonicalInput({ negocioId: 'b', titulo: 'Concierto de prueba', descripcion: 'Descripción', city: 'Ledesma', fechaLocal: '2027-01-10', fuentes: [{ url: 'https://x.es/a' }] }), alt);
  assert.equal(ev.createdBy, 'alfred-altas'); assert.equal(ev.agenteCanonico, 'alfred');
});

test('almacén: la escritura sin mover la guardia solo se permite para agenteCanonico en un evento existente', async () => {
  const st = new FirestoreStore({ project: 'fixture', fetchImpl: async () => { throw Error('no debe llegar al transporte'); } });
  for (const o of [{ updateFields: ['titulo'], updateTime: '1' }, { updateFields: ['agenteCanonico', 'titulo'], updateTime: '1' }, { create: true, updateFields: ['agenteCanonico'] }, { updateTime: '1' }]) assert.equal(await code(st.write('eventos', 'ev_x', { agenteCanonico: 'alfred' }, { ...o, metadataOnly: true })), 'metadata_write_forbidden');
  assert.equal(await code(st.write('registro_fuentes', 'f', { a: 1 }, { updateFields: ['agenteCanonico'], updateTime: '1', metadataOnly: true })), 'metadata_write_forbidden');
});

// ---- Zonas jerárquicas ----
const REPARTO = [
  ...['Málaga', 'Castilla y León', 'La Rioja', 'Aragón'].map(zona => ({ zona, agente: 'conchi' })),
  ...['Salamanca', 'Extremadura', 'Castilla-La Mancha', 'Comunidad de Madrid'].map(zona => ({ zona, agente: 'alfie' })),
  ...['Galicia', 'Asturias', 'Cantabria', 'País Vasco', 'Navarra'].map(zona => ({ zona, agente: 'amalia' })),
  ...['Andalucía', 'Canarias'].map(zona => ({ zona, agente: 'alfred' })),
  ...['Cataluña', 'Comunidad Valenciana', 'Islas Baleares', 'Región de Murcia'].map(zona => ({ zona, agente: 'hark' }))
];
const alfred = conIdentidad(P('alfred-altas', ['board'])), lector = conIdentidad(P('panel', ['board_read']));

test('zonas: nombres canónicos (Comunidad de Madrid, Islas Baleares, Región de Murcia…) y claves estables', () => {
  assert.equal(nombreZona('Comunidad de Madrid'), 'Madrid'); assert.equal(nombreZona('Islas Baleares'), 'Illes Balears'); assert.equal(nombreZona('Región de Murcia'), 'Murcia'); assert.equal(nombreZona('Comunidad Valenciana'), 'Comunitat Valenciana'); assert.equal(nombreZona('Cataluña'), 'Cataluña');
  assert.equal(claveZona('Comunidad de Madrid'), claveZona('madrid')); assert.equal(nombreZona('Ledesma'), 'Ledesma');
});

test('reparto de Alfred en lote: simular no escribe; aplicar carga las 24 zonas con un solo aviso; repetir no cambia nada', async () => {
  const s = new Store(); const sim = await asignarZonasLote(s, { reparto: REPARTO, motivo: 'Reparto inicial' }, alfred);
  assert.equal(sim.modo, 'simular'); assert.equal(sim.nuevas, REPARTO.length); assert.equal(s.writes.length, 0);
  assert.equal(await code(asignarZonasLote(s, { reparto: REPARTO, motivo: 'Reparto inicial' }, lector)), 'forbidden');
  assert.equal(await code(asignarZonasLote(s, { reparto: [{ zona: 'Madrid', agente: 'alfie' }, { zona: 'Comunidad de Madrid', agente: 'hark' }], motivo: 'Repetida' }, alfred)), 'board_reparto_invalido');
  const ap = await asignarZonasLote(s, { reparto: REPARTO, motivo: 'Reparto inicial', modo: 'aplicar' }, alfred, { now }); assert.equal(ap.asignadas, REPARTO.length);
  const z = await listarZonas(s, {}, lector); assert.equal(z.total, REPARTO.length); assert.deepEqual(z.porAgente.hark.sort(), ['Cataluña', 'Comunitat Valenciana', 'Illes Balears', 'Murcia']);
  assert.equal((await listar(s, { tipo: 'asignacion' }, lector)).total, 1);
  assert.equal((await asignarZonasLote(s, { reparto: REPARTO, motivo: 'Reparto inicial', modo: 'aplicar' }, alfred, { now })).asignadas, 0);
});

test('jerarquía: la asignación más específica prevalece (Salamanca dentro de Castilla y León, Málaga dentro de Andalucía)', async () => {
  const s = new Store(); await asignarZonasLote(s, { reparto: REPARTO, motivo: 'Reparto inicial', modo: 'aplicar' }, alfred, { now });
  const q = async c => (await listarZonas(s, { consultar: c }, lector)).consulta.resuelve;
  assert.deepEqual([(await q({ provincia: 'Salamanca' })).agente, (await q({ provincia: 'Salamanca' })).nivel], ['alfie', 'provincia']);
  assert.equal((await q({ provincia: 'Burgos' })).agente, 'conchi'); assert.equal((await q({ provincia: 'Burgos' })).zona, 'Castilla y León');
  assert.equal((await q({ provincia: 'Málaga' })).agente, 'conchi'); assert.equal((await q({ provincia: 'Sevilla' })).agente, 'alfred'); assert.equal((await q({ provincia: 'Sevilla' })).zona, 'Andalucía');
  assert.equal((await q({ municipio: 'Ledesma', provincia: 'Salamanca', ccaa: 'Castilla y León' })).agente, 'alfie'); // municipio sin zona propia → provincia
  assert.equal((await q({ provincia: 'Madrid' })).agente, 'alfie'); assert.equal((await q({ ccaa: 'Comunidad de Madrid' })).agente, 'alfie');
  assert.equal((await q({ provincia: 'Ourense' })).agente, 'amalia'); assert.equal((await q({ provincia: 'Girona' })).agente, 'hark'); assert.equal((await q({ provincia: 'Las Palmas' })).agente, 'alfred');
  assert.equal(await q({ provincia: 'Segovia' }).then(r => r.agente), 'conchi'); assert.equal((await q({ ccaa: 'Canarias' })).agente, 'alfred');
  // un municipio con su propia asignación gana a la provincia
  await asignarZona(s, { zona: 'Béjar', agente: 'hark', motivo: 'Caso especial' }, alfred, { now });
  assert.equal((await q({ municipio: 'Béjar', provincia: 'Salamanca' })).agente, 'hark'); assert.equal((await q({ municipio: 'Ledesma', provincia: 'Salamanca' })).agente, 'alfie');
  assert.equal((await q({})) ?? null, null);
  assert.deepEqual(ubicacionDe({ municipio: 'Vigo', provincia: 'Galicia' }).region, 'Galicia'); // «Galicia» escrito en provincia es la comunidad
});

const fte = (id, o = {}) => ({ col: 'registro_fuentes', id, data: { id, nombre_entidad: 'Fuente ' + id, canal: 'web', url: 'https://x.es/' + id, identificador: 'x.es/' + id, estado: 'descubierta', ...o } });
test('fuentes sin responsable: se reparten por provincia o comunidad según el reparto; las irresolubles salen aparte y no se tocan; simulación + código', async () => {
  const s = new Store([
    fte('fte_web_sa', { provincia: 'Salamanca', region: 'Castilla y León' }), fte('fte_web_bu', { provincia: 'Burgos' }), fte('fte_web_ma', { provincia: 'Málaga', region: 'Andalucía' }), fte('fte_web_se', { provincia: 'Sevilla' }),
    fte('fte_web_ga', { region: 'Galicia', ambito: 'region' }), fte('fte_web_gal', { provincia: 'Galicia' }),
    fte('fte_web_nada', {}), fte('fte_web_pt', { provincia: 'Lisboa', municipio: 'Lisboa' }), fte('fte_web_ya', { provincia: 'Burgos', responsable: 'hark' }), fte('fte_web_fus', { provincia: 'Burgos', estado: 'fusionada' }), fte('fte_web_alias', { provincia: 'Burgos', responsable: 'alfred-altas' })
  ]);
  assert.equal(await code(repartirFuentes(s, {}, alfred)), 'board_sin_zonas');
  await asignarZonasLote(s, { reparto: REPARTO, motivo: 'Reparto inicial', modo: 'aplicar' }, alfred, { now });
  assert.equal(await code(repartirFuentes(s, {}, lector)), 'forbidden');
  const sim = await repartirFuentes(s, {}, alfred); const antes = s.writes.length;
  assert.equal(sim.modo, 'simular'); assert.equal(sim.candidatas, 8); assert.equal(sim.fuentesQueCambian, 6); assert.deepEqual(sim.porAgente, { alfie: 1, conchi: 2, alfred: 1, amalia: 2 });
  assert.equal(sim.sinZona.total, 2); assert.deepEqual(sim.sinZona.listado.map(x => [x.fuenteId, x.motivo]).sort(), [['fte_web_nada', 'sin_ubicacion'], ['fte_web_pt', 'zona_sin_agente']]);
  assert.equal(await code(repartirFuentes(s, { modo: 'aplicar', codigoConfirmacion: 'falso' }, alfred)), 'board_confirmacion_invalida'); assert.equal(s.writes.length, antes);
  const ok = await repartirFuentes(s, { modo: 'aplicar', codigoConfirmacion: sim.codigoConfirmacion }, alfred, { now }); assert.equal(ok.reasignadas, 6); assert.equal(ok.sinZona, 2);
  const r = id => s.docs.get('registro_fuentes/' + id).data;
  assert.equal(r('fte_web_sa').responsable, 'alfie'); assert.equal(r('fte_web_bu').responsable, 'conchi'); assert.equal(r('fte_web_ma').responsable, 'conchi'); assert.equal(r('fte_web_se').responsable, 'alfred'); assert.equal(r('fte_web_ga').responsable, 'amalia'); assert.equal(r('fte_web_gal').responsable, 'amalia');
  assert.equal(r('fte_web_nada').responsable, undefined); assert.equal(r('fte_web_ya').responsable, 'hark'); assert.equal(r('fte_web_fus').responsable, undefined); assert.equal(r('fte_web_alias').responsable, 'alfred-altas');
  assert.equal(r('fte_web_sa').modificada_por, 'alfred'); assert.equal(r('fte_web_sa').historial.at(-1).cambios[0].despues, 'alfie');
  assert.equal((await repartirFuentes(s, {}, alfred)).fuentesQueCambian, 0);
});

test('reasignar_fuentes_zona respeta la jerarquía: reasignar Castilla y León a Conchi no toca Salamanca (de Alfie)', async () => {
  const s = new Store([fte('fte_web_sa', { provincia: 'Salamanca', region: 'Castilla y León', responsable: 'alfie' }), fte('fte_web_bu', { provincia: 'Burgos', region: 'Castilla y León', responsable: 'hark' }), fte('fte_web_so', { provincia: 'Soria', responsable: 'conchi' })]);
  await asignarZonasLote(s, { reparto: REPARTO, motivo: 'Reparto inicial', modo: 'aplicar' }, alfred, { now });
  const sim = await reasignarFuentesZona(s, { zona: 'Castilla y León', agente: 'conchi' }, alfred); assert.equal(sim.fuentesQueCambian, 1); assert.equal(sim.muestra[0].fuenteId, 'fte_web_bu');
  const ok = await reasignarFuentesZona(s, { zona: 'Castilla y León', agente: 'conchi', modo: 'aplicar', codigoConfirmacion: sim.codigoConfirmacion }, alfred, { now }); assert.equal(ok.reasignadas, 1);
  assert.equal(s.docs.get('registro_fuentes/fte_web_sa').data.responsable, 'alfie'); assert.equal(s.docs.get('registro_fuentes/fte_web_bu').data.responsable, 'conchi');
});

test('migración de identidades (ensayo puro): informe por colección y alias; no borra; eventos solo añaden agenteCanonico; huella determinista', () => {
  const R = (id, data) => ({ id, data, updateTime: '1' });
  const col = {
    tablon_agentes: [R('m1', { hilo: 'm1', autor: 'alfred-altas', agente: 'alfred-altas', destinatarios: ['amalia-asistente', 'amalia'], estado: 'resuelto', resuelto_por: 'alfred-altas' }), R('m2', { hilo: 'm1', autor: 'conchi', agente: 'conchi', destinatarios: ['alfred'] })],
    tareas_agentes: [R('t1', { agente: 'amalia-asistente', creada_por: 'amalia-asistente', historial: [{ por: 'amalia-asistente' }, { por: 'alfred' }] })],
    zonas_agentes: [R('madrid', { agente: 'alfie', asignada_por: 'alfred-altas', historial: [] })],
    tablon_lecturas: [R('alfred-altas', { hilos: { m1: '2026-11-21T10:00:00Z' } }), R('conchi', { hilos: {} })],
    registro_fuentes: [R('f1', { responsable: 'alfred-altas', creada_por: 'alfred-altas', modificada_por: 'amalia-asistente', historial: [{ por: 'alfred-altas' }] }), R('f2', { responsable: 'alfred' }), R('f3', {})],
    eventos: [R('e1', { createdBy: 'alfred-altas' }), R('e2', { createdBy: 'alfred' }), R('e3', { createdBy: 'conchi-owner' }), R('e4', { createdBy: 'ia-externa' }), R('e5', {}), R('e6', { createdBy: 'conchi', agenteCanonico: 'conchi' })]
  };
  const { informe, cambios, huella } = planificarIdentidades(col);
  assert.deepEqual(informe.resumen.tablon_agentes, { documentos: 2, cambian: 1 }); assert.deepEqual(informe.porColeccion.tablon_agentes.porAlias['alfred-altas'], { autor: 1, agente: 1, resuelto_por: 1 }); assert.deepEqual(informe.porColeccion.tablon_agentes.porAlias['amalia-asistente'], { destinatarios: 1 });
  assert.equal(informe.resumen.tareas_agentes.cambian, 1); assert.equal(informe.porColeccion.tareas_agentes.porAlias['amalia-asistente']['historial.por'], 1);
  assert.equal(informe.resumen.registro_fuentes.cambian, 1); assert.deepEqual(informe.porColeccion.registro_fuentes.porAlias['alfred-altas'], { responsable: 1, creada_por: 1, 'historial.por': 1 });
  assert.equal(informe.resumen.zonas_agentes.cambian, 1); assert.equal(informe.resumen.tablon_lecturas.cambian, 1);
  assert.deepEqual(informe.eventos, { documentos: 6, aAnadir: 3, yaTienen: 1, sinCreatedBy: 1 }); assert.deepEqual(informe.sinMapear, { 'ia-externa': 1 });
  const ev = cambios.filter(c => c.tipo === 'metadato_evento'); assert.deepEqual(ev.map(c => [c.id, c.set.agenteCanonico]), [['e1', 'alfred'], ['e2', 'alfred'], ['e3', 'conchi']]);
  assert.ok(ev.every(c => Object.keys(c.set).join() === 'agenteCanonico')); // createdBy no se toca
  const f1 = cambios.find(c => c.id === 'f1'); assert.equal(f1.set.responsable, 'alfred'); assert.equal(f1.set.creada_por_principal, 'alfred-altas'); assert.equal(f1.set.modificada_por_principal, 'amalia-asistente'); assert.deepEqual(f1.set.historial[0], { por: 'alfred', principal: 'alfred-altas' });
  const m1 = cambios.find(c => c.id === 'm1'); assert.equal(m1.set.principal, 'alfred-altas'); assert.deepEqual(m1.set.destinatarios, ['amalia']);
  assert.equal(planificarIdentidades(col).huella, huella); assert.ok(cambios.every(c => c.tipo !== 'borrar'));
});

test('fuentes que solo traen el municipio se ubican por otras fuentes del mismo municipio; «Ámbito regional X» es una comunidad, no un municipio', async () => {
  assert.deepEqual(ubicacionDe({ municipio: 'Ámbito regional Castilla-La Mancha' }), { municipio: null, comarca: null, zona: null, provincia: null, region: 'Castilla-La Mancha' });
  assert.equal(ubicacionDe({ municipio: 'Por determinar' }).municipio, null);
  const s = new Store([fte('fte_web_a', { municipio: 'Béjar', provincia: 'Salamanca' }), fte('fte_web_b', { municipio: 'Béjar' }), fte('fte_web_c', { municipio: 'Almagro' }), fte('fte_web_d', { municipio: 'Ámbito regional Castilla-La Mancha' }), fte('fte_web_e', { municipio: 'Ámbito editorial por contrastar' })]);
  await asignarZonasLote(s, { reparto: REPARTO, motivo: 'Reparto inicial', modo: 'aplicar' }, alfred, { now });
  const sim = await repartirFuentes(s, {}, alfred);
  assert.equal(sim.ubicadasPorSuMunicipio, 1); assert.deepEqual(sim.porAgente, { alfie: 3 }); // Béjar (Salamanca) y la comunidad Castilla-La Mancha, ambas de Alfie, más fte_web_a
  assert.deepEqual(sim.sinZona.listado.map(x => [x.fuenteId, x.motivo]).sort(), [['fte_web_c', 'zona_sin_agente'], ['fte_web_e', 'sin_ubicacion']]);
});

test('altas recientes: filtro por agente canónico (alfred agrupa alfred y alfred-altas) y cada alta devuelve su agente', async () => {
  const { EventService } = await import('../event-service.mjs');
  const ev = (id, createdBy, extra = {}) => ({ col: 'eventos', id, data: { negocioId: 'b', titulo: id, createdBy, fechaCreacion: '2026-11-2' + id.slice(-1) + 'T10:00:00Z', ...extra } });
  const s = new Store([{ col: 'amalia_catalog_guard', id: 'eventos', data: { epoch: 1 } }, ev('e1', 'alfred-altas'), ev('e2', 'alfred'), ev('e3', 'amalia-asistente'), ev('e4', 'conchi', { agenteCanonico: 'conchi' })]);
  const svc = new EventService(s, {}, { warm: false }), p = P('r', ['read']);
  assert.equal((await svc.listRecentAdmissions({ agente: 'alfred' }, p)).items.length, 2); assert.equal((await svc.listRecentAdmissions({ agente: 'amalia' }, p)).items[0].agente, 'amalia');
  assert.equal((await svc.listRecentAdmissions({ createdBy: 'alfred-altas' }, p)).items.length, 1);
});
