import test from 'node:test';
import assert from 'node:assert/strict';
import { escanearDuplicados } from '../dedup_amalia.mjs';
import { EventService } from '../event-service.mjs';
import { fail, originKey } from '../event-domain.mjs';

const prev = (o = {}) => ({ id: 'ev_a', data: { titulo: 'Ruta de senderismo del Duero', city: 'Arévalo', fechaLocal: '2026-11-21', horaLocal: '11:00', sesionId: '2026-11-21/11:00', sesionExplicita: false, fuentes: [{ url: 'https://arevalo.example/agenda' }], ...o } });
const cand = (o = {}) => ({ negocioId: 'b1', titulo: 'Ruta de senderismo', city: 'Pedrosillo', fechaLocal: '2026-11-21', horaLocal: '11:00', sesionId: '2026-11-21/11:00', sesionExplicita: false, fuentes: [{ url: 'https://pedrosillo.example/ruta' }], ...o });

test('misma hora implícita en otro municipio con títulos parecidos es solo aviso', () => {
  const r = escanearDuplicados(cand(), [prev()]);
  assert.deepEqual(r.coincidencias, []);
  assert.equal(r.informativas.length, 1);
  assert.equal(r.informativas[0].motivos[0], 'sesion_coincidente');
});

test('buscar_duplicados_global: una reserva de origen sin evento sigue bloqueando como en la admisión', async () => {
  const origen = { proveedor: 'p', id_externo: 'x', id_sesion: 's' };
  const store = { get: async (c, id) => (c === 'amalia_event_reservations' && id === originKey(origen) ? { id, data: { eventId: 'ev_purgado' } } : null), list: async () => [] };
  const svc = new EventService(store, {}, { warm: false });
  const r = await svc.findDuplicates({ origen, titulo: 'X', city: 'Y', fechaLocal: '2026-11-21' }, { id: 't', actions: ['*'], businesses: ['*'] });
  assert.ok(r.coincidencias.some(c => c.motivos.includes('reserva_huerfana') && c.eventId === 'ev_purgado'));
});

test('admisión rechazada por duplicado/contienda: mismo error, estado explícito y recibo consultable', async () => {
  const store = { get: async () => null, list: async () => [] };
  const svc = new EventService(store, {}, { warm: false });
  const p = { id: 'ag', actions: ['*'], businesses: ['*'] };
  svc.admitCandidateInner = async () => fail('duplicate_event_conflict', { coincidencias: [{ eventId: 'ev_x', motivos: ['url_fuente'], confianza: 'exacta' }], revision: true });
  await assert.rejects(svc.admitCandidate({ evento: { negocioId: 'b1', requestId: 'r-1' } }, p), e => e.code === 'duplicate_event_conflict' && e.details.estado === 'review_required' && e.details.requestId === 'r-1');
  const rec = await svc.registryAdmissionReceipt({ requestId: 'r-1' }, p);
  assert.equal(rec.estado, 'review_required'); assert.equal(rec.coincidencias[0].eventId, 'ev_x');
  svc.admitCandidateInner = async () => fail('admission_contended', { repreparar: true });
  await assert.rejects(svc.admitCandidate({ evento: { negocioId: 'b1', requestId: 'r-2' } }, p), e => e.code === 'admission_contended' && e.details.estado === 'contended');
  assert.equal((await svc.registryAdmissionReceipt({ requestId: 'r-2' }, p)).estado, 'contended');
  assert.equal(svc.inflight.size, 0);
});
