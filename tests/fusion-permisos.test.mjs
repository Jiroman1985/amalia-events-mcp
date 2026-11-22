import test from 'node:test';
import assert from 'node:assert/strict';
import { conIdentidad, PERMISOS_AGENTE } from '../identidad.mjs';
import { authenticate } from '../server-v2.mjs';
import { authorize, hash } from '../event-domain.mjs';
import { fusionarFuentes, masRestrictivo } from '../fusion-fuentes.mjs';
import { FirestoreStore } from '../firestore-store.mjs';

class Store {
  constructor(seed = []) { this.docs = new Map(seed.map(r => [r.col + '/' + r.id, { id: r.id, data: r.data, updateTime: '1' }])); this.writes = []; this.n = 1; }
  async get(c, id) { const r = this.docs.get(c + '/' + id); return r ? { id, data: structuredClone(r.data), updateTime: r.updateTime } : null; }
  async listAll(c) { return [...this.docs].filter(([k]) => k.startsWith(c + '/')).map(([, r]) => ({ id: r.id, data: structuredClone(r.data), updateTime: r.updateTime })); }
  async write(c, id, data, o = {}) {
    const k = c + '/' + id, cur = this.docs.get(k);
    if (cur && o.updateTime !== cur.updateTime) { const e = new Error('version_conflict'); e.code = 'version_conflict'; throw e; }
    this.writes.push({ c, id, campos: o.updateFields || null, metadataOnly: !!o.metadataOnly });
    this.docs.set(k, { id, data: o.updateFields ? { ...cur.data, ...data } : structuredClone(data), updateTime: String(++this.n) }); return {};
  }
}
const P = (id, actions, businesses = ['*']) => ({ id, actions, businesses });
const code = p => p.then(() => null, e => e.code);
const alfred = conIdentidad(P('alfred-altas', ['board']));
const fuente = (extra = {}) => ({ canal: 'web', identificador: 'x.es/a', url: 'https://x.es/a', estado: 'activa', municipio: 'Monesterio', eventos_aportados: 0, frecuencia_dias: 7, ...extra });
const seed = () => new Store([
  { col: 'registro_fuentes', id: 'fte_web_dup00000000000000000000', data: fuente({ identificador: 'bandomovil.com/monesterio', url: 'https://bandomovil.com/monesterio', eventos_aportados: 1, canales_secundarios: [{ canal: 'instagram', identificador: 'mon', url: 'https://www.instagram.com/mon/' }] }) },
  { col: 'registro_fuentes', id: 'fte_web_dest0000000000000000000', data: fuente({ identificador: 'bandomovil.com/web_widget.php?municipio=monesterio', url: 'https://bandomovil.com/web_widget.php?municipio=monesterio', codigo: 'F-BAD-0004', frecuencia_dias: 3 }) },
  { col: 'eventos', id: 'ev_1', data: { titulo: 'Acto 25N', fuenteId: 'fte_web_dup00000000000000000000', negocioId: 'b1', version: 1 } },
  { col: 'eventos', id: 'ev_2', data: { titulo: 'Otro', fuenteId: 'fte_web_otra', negocioId: 'b1', version: 1 } }
]);
const reloj = () => '2026-11-21T12:00:00.000Z';

test('permisos por agente: alfred (cualquier token) edita, retira y recupera en cualquier negocio y administra; conchi retira; lola no', () => {
  for (const id of ['alfred', 'alfred-altas', 'alfred-ediciones']) {
    const p = conIdentidad(P(id, ['admit', 'read'], ['biz_a']));
    for (const a of ['edit', 'retire', 'restore', 'board_admin']) assert.equal(authorize(p, 'biz_cualquiera', a), undefined, id + ' ' + a);
    assert.equal(p.agente, 'alfred'); assert.equal(p.principalOriginal, id); assert.equal(p.id, id);
  }
  const conchi = conIdentidad(P('conchi', ['admit', 'read', 'board']));
  assert.equal(authorize(conchi, 'b', 'retire'), undefined); assert.equal(authorize(conchi, 'b', 'restore'), undefined);
  assert.throws(() => authorize(conchi, 'b', 'edit'), { message: 'forbidden' }); assert.throws(() => authorize(conchi, 'b', 'board_admin'), { message: 'forbidden' });
  assert.deepEqual(Object.keys(PERMISOS_AGENTE).sort(), ['alfred', 'conchi']);
});

test('lola con read, read_public y board: sin admit, edit, retire ni board_admin, y su autor sale como «lola»', () => {
  const t = 'token-lola-de-prueba', reg = [{ id: 'lola', tokenHash: hash(t), actions: ['read', 'read_public', 'board'], businesses: ['*'] }];
  const p = authenticate('Bearer ' + t, reg);
  assert.equal(p.agente, 'lola'); assert.equal(p.principalOriginal, 'lola');
  for (const a of ['read', 'read_public', 'board']) assert.equal(authorize(p, null, a), undefined);
  for (const a of ['admit', 'edit', 'retire', 'restore', 'board_admin', 'complete']) assert.throws(() => authorize(p, null, a), { message: 'forbidden' }, a);
});

test('metadataOnly en eventos: solo fuenteId y su rastro; cualquier otro campo se rechaza', async () => {
  const st = new FirestoreStore({ project: 'p', key: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.equal(await code(st.write('eventos', 'e', { titulo: 'x' }, { updateFields: ['fuenteId', 'titulo'], updateTime: '1', metadataOnly: true })), 'metadata_write_forbidden');
  assert.equal(await code(st.write('registro_fuentes', 'f', {}, { updateFields: ['fuenteId'], updateTime: '1', metadataOnly: true })), 'metadata_write_forbidden');
});

test('el estado más restrictivo manda: bloqueada > descartada > pausada > activa', () => {
  assert.equal(masRestrictivo('activa', 'bloqueada'), 'bloqueada'); assert.equal(masRestrictivo('bloqueada', 'activa'), 'bloqueada');
  assert.equal(masRestrictivo('pausada', 'descartada'), 'descartada'); assert.equal(masRestrictivo('descubierta', 'activa'), 'activa'); assert.equal(masRestrictivo(undefined, 'pausada'), 'pausada');
});

test('fusionar_fuentes: solo board_admin; simular no escribe y da el plan', async () => {
  const s = seed();
  const input = { fuenteDuplicada: 'fte_web_dup00000000000000000000', fuenteDestino: 'fte_web_dest0000000000000000000', motivo: 'Misma fuente Bandomovil' };
  assert.equal(await code(fusionarFuentes(s, input, conIdentidad(P('alfie', ['board'])), { now: reloj })), 'forbidden');
  const v = await fusionarFuentes(s, input, alfred, { now: reloj });
  assert.equal(v.vistaPrevia, true); assert.equal(v.escrito, false); assert.equal(s.writes.length, 0);
  assert.deepEqual(v.eventosAMover.map(e => e.eventId), ['ev_1']); assert.equal(v.aliasQueSeAñaden.length, 2); assert.match(v.codigoConfirmacion, /^[0-9a-f]{12}$/);
});

test('fusionar_fuentes: aplicar mueve el evento, une alias, suma contadores, marca fusionada con enlace y no borra', async () => {
  const s = seed(), input = { fuenteDuplicada: 'fte_web_dup00000000000000000000', fuenteDestino: 'fte_web_dest0000000000000000000', motivo: 'Misma fuente Bandomovil' };
  const v = await fusionarFuentes(s, input, alfred, { now: reloj });
  assert.equal(await code(fusionarFuentes(s, { ...input, modo: 'aplicar' }, alfred, { now: reloj })), 'confirmation_mismatch');
  assert.equal(await code(fusionarFuentes(s, { ...input, modo: 'aplicar', codigoConfirmacion: 'x'.repeat(12) }, alfred, { now: reloj })), 'confirmation_mismatch');
  const r = await fusionarFuentes(s, { ...input, modo: 'aplicar', codigoConfirmacion: v.codigoConfirmacion }, alfred, { now: reloj });
  assert.equal(r.aplicado, true); assert.deepEqual(r.eventosMovidos, ['ev_1']);
  const ev = s.docs.get('eventos/ev_1').data; assert.equal(ev.fuenteId, 'fte_web_dest0000000000000000000'); assert.equal(ev.fuenteIdAnterior, 'fte_web_dup00000000000000000000'); assert.equal(ev.fuenteMovidaPor, 'alfred'); assert.equal(ev.titulo, 'Acto 25N');
  assert.equal(s.docs.get('eventos/ev_2').data.fuenteId, 'fte_web_otra');
  const w = s.writes.find(x => x.c === 'eventos'); assert.equal(w.metadataOnly, true); assert.deepEqual(w.campos, ['fuenteId', 'fuenteIdAnterior', 'fuenteMovidaPor', 'fuenteMovidaEn', 'fuenteMovidaMotivo']);
  const dest = s.docs.get('registro_fuentes/fte_web_dest0000000000000000000').data, dup = s.docs.get('registro_fuentes/fte_web_dup00000000000000000000').data;
  assert.equal(dest.eventos_aportados, 1); assert.equal(dest.canales_secundarios.length, 2); assert.ok(dest.canales_secundarios.some(x => x.identificador === 'bandomovil.com/monesterio' && x.fuenteIdAnterior === 'fte_web_dup00000000000000000000'));
  assert.ok(dest.codigos_alternativos.includes('fte_web_dup00000000000000000000')); assert.equal(dest.frecuencia_dias, 3);
  assert.equal(dup.estado, 'fusionada'); assert.equal(dup.duplicado_de, 'fte_web_dest0000000000000000000'); assert.equal(dup.estado_anterior, 'activa'); assert.equal(dup.fusionada_por, 'alfred'); assert.deepEqual(dup.eventos_movidos, ['ev_1']);
  assert.equal(dest.historial.at(-1).por, 'alfred'); assert.equal(dest.historial.at(-1).principal, 'alfred-altas');
  assert.equal(await code(fusionarFuentes(s, input, alfred, { now: reloj })), 'fuente_fusionada');
});

test('fusionar_fuentes: conserva el estado más restrictivo y su motivo de bloqueo; valida entradas', async () => {
  const s = seed(); const d = s.docs.get('registro_fuentes/fte_web_dup00000000000000000000'); d.data.estado = 'bloqueada'; d.data.motivo_bloqueo = { texto: 'Licencia no permite reutilizar', licenciaUrl: null };
  const input = { fuenteDuplicada: 'fte_web_dup00000000000000000000', fuenteDestino: 'fte_web_dest0000000000000000000', motivo: 'Misma fuente' };
  const v = await fusionarFuentes(s, input, alfred, { now: reloj }); assert.equal(v.fuenteDestino.estadoResultante, 'bloqueada'); assert.equal(v.fuenteDestino.cambiaEstado, true);
  await fusionarFuentes(s, { ...input, modo: 'aplicar', codigoConfirmacion: v.codigoConfirmacion }, alfred, { now: reloj });
  const dest = s.docs.get('registro_fuentes/fte_web_dest0000000000000000000').data; assert.equal(dest.estado, 'bloqueada'); assert.equal(dest.motivo_bloqueo.texto, 'Licencia no permite reutilizar');
  assert.equal(await code(fusionarFuentes(seed(), { ...input, fuenteDestino: input.fuenteDuplicada }, alfred)), 'fuente_fusion_invalida');
  assert.equal(await code(fusionarFuentes(seed(), { ...input, motivo: 'no' }, alfred)), 'fusion_motivo_requerido');
  assert.equal(await code(fusionarFuentes(seed(), { ...input, fuenteDestino: 'fte_web_noexiste0000' }, alfred)), 'fuente_no_encontrada');
});

test('fusionar_fuentes: si un evento falla no se toca ninguna fuente', async () => {
  const s = seed(), input = { fuenteDuplicada: 'fte_web_dup00000000000000000000', fuenteDestino: 'fte_web_dest0000000000000000000', motivo: 'Misma fuente' };
  const v = await fusionarFuentes(s, input, alfred, { now: reloj }); const w = s.write.bind(s);
  s.write = async (c, ...r) => { if (c === 'eventos') { const e = new Error('x'); e.code = 'version_conflict'; throw e; } return w(c, ...r); };
  const r = await fusionarFuentes(s, { ...input, modo: 'aplicar', codigoConfirmacion: v.codigoConfirmacion }, alfred, { now: reloj });
  assert.equal(r.aplicado, false); assert.equal(r.parcial, true); assert.equal(s.docs.get('registro_fuentes/fte_web_dup00000000000000000000').data.estado, 'activa');
});
