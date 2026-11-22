// negocio-edicion.mjs — editar_negocio: corrige nombre, dirección, sitio web y redes de un negocio ya registrado (permiso edit, simular, expectedVersion).
import { authorize, fail, businessReferenceUrl } from './event-domain.mjs';
import { agenteCanonico } from './identidad.mjs';
const REDES = ['instagram', 'facebook', 'tiktok', 'youtube'];
const CAMPOS = ['nombre', 'direccion', 'sitioWeb', ...REDES];
const url = (v, campo) => { if (typeof v !== 'string' || v.length > 300) fail('invalid_field', { campo }); try { return businessReferenceUrl(v); } catch (e) { fail('invalid_field', { campo, ayuda: 'Debe ser una URL https pública válida.' }); } };
/** Devuelve siempre el diff; solo escribe si simular=false. Sin `version` previa, la versión actual es 0. */
export async function editarNegocio(store, input, principal) {
  const { negocioId, expectedVersion, motivo, simular = false } = input;
  authorize(principal, negocioId, 'edit');
  const desconocidos = Object.keys(input).filter(k => !['negocioId', 'expectedVersion', 'motivo', 'simular', ...CAMPOS].includes(k));
  if (desconocidos.length) fail('invalid_field', { campo: desconocidos[0] });
  if (typeof motivo !== 'string' || motivo.trim().length < 3 || motivo.length > 500) fail('reason_required');
  const cambios = Object.fromEntries(CAMPOS.filter(k => k in input && input[k] !== undefined).map(k => [k, input[k]]));
  if (!Object.keys(cambios).length) fail('invalid_field', { campo: 'cambios', ayuda: `Indica al menos uno de: ${CAMPOS.join(', ')}.` });
  const row = await store.get('negocios', negocioId); if (!row) fail('business_not_found');
  const d = row.data, version = d.version || 0;
  if (expectedVersion !== version) fail('version_conflict', { currentVersion: version, ayuda: 'El negocio cambió: vuelve a leerlo y repite con la versión actual.' });
  const fi = { ...(d.fuentesInformacion || {}) }, set = {};
  if ('nombre' in cambios) { if (typeof cambios.nombre !== 'string' || cambios.nombre.trim().length < 2 || cambios.nombre.length > 180) fail('invalid_field', { campo: 'nombre' }); set.nombre = cambios.nombre.trim(); set.name = set.nombre; }
  if ('direccion' in cambios) { if (cambios.direccion !== null && (typeof cambios.direccion !== 'string' || cambios.direccion.trim().length < 2 || cambios.direccion.length > 200)) fail('invalid_field', { campo: 'direccion' }); set.direccion = cambios.direccion === null ? null : cambios.direccion.trim(); }
  if ('sitioWeb' in cambios) { if (cambios.sitioWeb === null) fail('invalid_field', { campo: 'sitioWeb', ayuda: 'El sitio web no se puede quitar; corrígelo con la URL buena.' }); fi.sitioWeb = url(cambios.sitioWeb, 'sitioWeb'); }
  for (const r of REDES) if (r in cambios) { if (cambios[r] === null) delete fi[r]; else fi[r] = String(cambios[r]).trim().slice(0, 300); if (cambios[r] !== null && !fi[r]) fail('invalid_field', { campo: r }); }
  if (!fi.sitioWeb && !REDES.some(r => fi[r])) fail('source_required', { ayuda: 'El negocio debe conservar al menos una fuente pública.' });
  if (cambios.sitioWeb !== undefined || REDES.some(r => r in cambios)) set.fuentesInformacion = fi;
  const diff = {}; for (const [k, v] of Object.entries(set)) { if (JSON.stringify(d[k] ?? null) !== JSON.stringify(v ?? null)) diff[k] = { antes: d[k] ?? null, despues: v ?? null }; }
  if (!Object.keys(diff).length) return { negocioId, escrito: false, sinCambios: true, version };
  const now = new Date().toISOString(), patch = { ...Object.fromEntries(Object.keys(diff).map(k => [k, set[k]])), version: version + 1, fechaActualizacion: now, updatedBy: agenteCanonico(principal.id), updatedByPrincipal: principal.id };
  if (simular) return { simulado: true, escrito: false, negocioId, versionActual: version, versionResultante: version + 1, camposQueCambian: Object.keys(diff), cambios: diff, siguientePaso: `Repite sin simular, con expectedVersion=${version} y el mismo motivo. Nada se ha escrito.` };
  await store.write('negocios', negocioId, { ...d, ...patch }, { updateTime: row.updateTime, updateFields: Object.keys(patch), audit: { version: patch.version, actor: agenteCanonico(principal.id), actorPrincipal: principal.id, action: 'business_edited', reason: motivo.trim(), at: now, before: Object.fromEntries(Object.keys(diff).map(k => [k, d[k] ?? null])), after: Object.fromEntries(Object.keys(diff).map(k => [k, patch[k]])) } });
  return { negocioId, escrito: true, version: patch.version, camposQueCambian: Object.keys(diff), cambios: diff };
}
