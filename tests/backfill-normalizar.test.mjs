import test from 'node:test';
import assert from 'node:assert/strict';
import { fechaDeAntiguo, municipioDeAntiguo, planNormalizacion, aplicarPlan } from '../normalizacion-antiguos.mjs';

const fila = (id, data, updateTime = 't' + id) => ({ id, data, updateTime });
const base = [
  fila('a', { nombre: 'Concierto', fecha_inicio: '2099-03-05', ciudad: 'Almagro', provincia: 'Ciudad Real' }),
  fila('b', { nombre: 'Teatro', dateTime: '22 de marzo de 2099, 21:00h', town: 'Almagro' }),
  fila('c', { nombre: 'Feria', dateTime: '2099-04-01T20:00:00+02:00', ubicacion: 'Almagro' }),
  fila('d', { nombre: 'Utc', dateTime: '2099-04-01T22:30:00Z', ciudad: 'Almagro' }),
  fila('e', { nombre: 'Sin fecha', dateTime: '', ciudad: 'Viena' }),
  fila('f', { titulo: 'Ya canónico', fechaLocal: '2099-05-05', city: 'Almagro', provincia: 'Ciudad Real', version: 3 }),
  fila('g', { nombre: 'Distinta', fechaLocal: '2099-06-06', fecha_inicio: '2099-06-07', city: 'Almagro', provincia: 'Ciudad Real' }),
  fila('h', { nombre: 'Provincia en ubicacion', fecha_inicio: '2099-07-01', ubicacion: { municipio: 'Pueblo', provincia: 'Toledo' } }),
];

test('fechaDeAntiguo: fecha_inicio, dateTime ISO con desfase, texto en español; UTC y vacío se omiten', () => {
  assert.deepEqual(fechaDeAntiguo({ fecha_inicio: '2099-03-05' }), { fecha: '2099-03-05', origen: 'fecha_inicio' });
  assert.equal(fechaDeAntiguo({ dateTime: '2099-04-01T20:00:00+02:00' }).fecha, '2099-04-01');
  assert.equal(fechaDeAntiguo({ dateTime: '21 de marzo de 2099, 21:00h' }).fecha, '2099-03-21');
  assert.equal(fechaDeAntiguo({ dateTime: '2099-04-01T22:30:00Z' }).motivo, 'dateTime_utc_ambiguo');
  assert.equal(fechaDeAntiguo({ dateTime: '31 de febrero de 2099' }).motivo, 'dateTime_no_interpretable');
  assert.equal(fechaDeAntiguo({ fecha_inicio: '2099-13-45' }).motivo, 'sin_fecha');
});

test('municipioDeAntiguo toma ciudad, town o ubicación (texto u objeto)', () => {
  assert.equal(municipioDeAntiguo({ ciudad: ' Almagro ' }), 'Almagro');
  assert.equal(municipioDeAntiguo({ ubicacion: { municipio: 'Pueblo' } }), 'Pueblo');
  assert.equal(municipioDeAntiguo({ ubicacion: { latitude: 1, longitude: 2 } }), null);
});

test('planNormalizacion: rellena huecos, no pisa nada y explica lo omitido', () => {
  const p = planNormalizacion(base), por = Object.fromEntries(p.cambios.map(c => [c.id, c]));
  assert.deepEqual(por.a.despues, { fechaLocal: '2099-03-05', city: 'Almagro' });
  assert.deepEqual(por.b.despues, { fechaLocal: '2099-03-22', city: 'Almagro', provincia: 'Ciudad Real' }); // provincia única del municipio
  assert.equal(por.c.despues.fechaLocal, '2099-04-01');
  assert.equal(por.d.despues.fechaLocal, undefined); assert.ok(p.omitidos.fecha_dateTime_utc_ambiguo.ejemplos.includes('d'));
  assert.ok(p.omitidos.fecha_sin_fecha.ejemplos.includes('e')); assert.ok(p.omitidos.provincia_desconocida.ejemplos.includes('e'));
  assert.equal(por.f, undefined, 'un evento ya normalizado no cambia');
  assert.equal(por.g, undefined); assert.ok(p.omitidos.fecha_inicio_distinta_de_fechaLocal.ejemplos.includes('g'));
  assert.equal(por.h.despues.provincia, 'Toledo'); assert.equal(por.h.despues.city, 'Pueblo');
  assert.equal(p.resumen.conCambios, p.cambios.length);
});

test('provincia: si un municipio tiene dos provincias distintas en el catálogo no se infiere', () => {
  const rows = [fila('x', { city: 'Villanueva', provincia: 'Badajoz' }), fila('y', { city: 'Villanueva', provincia: 'Córdoba' }), fila('z', { nombre: 'Antiguo', fecha_inicio: '2099-01-01', ciudad: 'Villanueva' })];
  const p = planNormalizacion(rows), z = p.cambios.find(c => c.id === 'z');
  assert.equal(z.despues.provincia, undefined); assert.ok(p.omitidos.provincia_desconocida.ejemplos.includes('z'));
});

test('aplicarPlan: lotes con versión+1, auditoría y guardia; un lote fallido no frena a los demás', async () => {
  const plan = planNormalizacion(base), escritos = [];
  let fallar = true;
  const store = {
    async get() { return { updateTime: 'g1', data: { epoch: 4 } }; },
    async writeMany(items, { guard }) { if (fallar && items.some(i => i.key === 'a')) { fallar = false; throw Object.assign(new Error('x'), { code: 'version_conflict' }); } assert.deepEqual(guard, { updateTime: 'g1', epoch: 4 }); escritos.push(...items); },
  };
  const r = await aplicarPlan(store, plan, { lote: 1, now: '2026-11-24T10:00:00.000Z' });
  assert.equal(r.fallos.length, 1); assert.equal(r.fallos[0].error, 'version_conflict'); assert.equal(r.ok + r.fallos[0].n, plan.cambios.length);
  const b = escritos.find(i => i.key === 'b');
  assert.equal(b.data.version, 1); assert.equal(b.data.fechaLocal, '2099-03-22'); assert.deepEqual(b.data.normalizacion_backfill_v1.campos.sort(), ['city', 'fechaLocal', 'provincia']);
  assert.equal(b.audit.version, 1); assert.equal(b.audit.action, 'normalizado_antiguo'); assert.equal(b.audit.before.fechaLocal, null);
  assert.ok(b.updateFields.includes('fechaLocal') && b.updateFields.includes('version'));
});
