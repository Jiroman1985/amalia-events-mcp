// migracion-identidades.mjs — planificación PURA de la unificación de identidades (alias → agente canónico). No lee ni escribe nada.
// Reglas: no se borra nada; el valor original se conserva en un campo aparte (*_principal / principal) y en eventos solo se AÑADE agenteCanonico (createdBy no se toca).
import { hash } from './event-domain.mjs';
import { agenteCanonico, AGENTES } from './identidad.mjs';

const cuenta = (informe, col, alias, campo) => { const c = informe.porColeccion[col] ||= { documentos: 0, cambian: 0, porAlias: {} }; ((c.porAlias[alias] ||= {})[campo] = (c.porAlias[alias][campo] || 0) + 1); };
const cambia = v => typeof v === 'string' && v && agenteCanonico(v) !== v.toLowerCase().trim() ? agenteCanonico(v) : null;
const cambiaMayus = v => typeof v === 'string' && v && agenteCanonico(v) !== v ? agenteCanonico(v) : null;

export function planificarIdentidades(colecciones) {
  const informe = { porColeccion: {}, sinMapear: {}, eventos: { documentos: 0, aAnadir: 0, yaTienen: 0, sinCreatedBy: 0 } }, cambios = [];
  for (const [col, rows] of Object.entries(colecciones)) {
    const c = informe.porColeccion[col] ||= { documentos: 0, cambian: 0, porAlias: {} }; c.documentos = rows.length;
    if (col === 'eventos') {
      for (const r of rows) {
        informe.eventos.documentos++; const d = r.data, cb = d.createdBy, set = {};
        if (!cb) informe.eventos.sinCreatedBy++;
        else {
          const canon = agenteCanonico(cb);
          if (!AGENTES.includes(canon)) informe.sinMapear[cb] = (informe.sinMapear[cb] || 0) + 1;
          else if (d.agenteCanonico === canon) informe.eventos.yaTienen++;
          else { informe.eventos.aAnadir++; cuenta(informe, col, cb, 'agenteCanonico'); set.agenteCanonico = canon; }
        }
        // Autores de modificaciones/retiradas/recuperaciones: el valor pasa a ser el agente canónico y el principal original se guarda en *Principal (createdBy no se toca).
        for (const k of ['updatedBy', 'retiradoPor', 'recuperadoPor']) { const n = cambiaMayus(d[k]); if (n) { cuenta(informe, col, d[k], k); set[k] = n; if (d[k + 'Principal'] == null) set[k + 'Principal'] = d[k]; informe.eventos[k] = (informe.eventos[k] || 0) + 1; } }
        if (Object.keys(set).length) { c.cambian++; cambios.push({ coleccion: col, id: r.id, updateTime: r.updateTime, tipo: 'metadato_evento', set }); }
      }
      continue;
    }
    for (const r of rows) {
      const d = r.data, set = {}, nota = (alias, campo) => cuenta(informe, col, alias, campo);
      const campo = (k, extraPrincipal) => { const n = cambia(d[k]); if (n) { nota(d[k], k); set[k] = n; if (extraPrincipal && d[extraPrincipal] == null) set[extraPrincipal] = d[k]; } };
      if (col === 'tablon_agentes') {
        campo('autor', 'principal'); campo('agente'); campo('resuelto_por', 'resuelto_por_principal');
        if (Array.isArray(d.destinatarios)) { const nuevos = d.destinatarios.map(x => agenteCanonico(x)); const dedup = [...new Set(nuevos)]; if (JSON.stringify(dedup) !== JSON.stringify(d.destinatarios)) { d.destinatarios.forEach(x => { if (agenteCanonico(x) !== x) nota(x, 'destinatarios'); }); set.destinatarios = dedup; } }
      } else if (col === 'tareas_agentes') {
        campo('agente'); campo('creada_por', 'creada_por_principal'); campo('asignada_por');
        if (Array.isArray(d.historial) && d.historial.some(h => cambia(h.por))) { d.historial.forEach(h => { if (cambia(h.por)) nota(h.por, 'historial.por'); }); set.historial = d.historial.map(h => cambia(h.por) ? { ...h, por: cambia(h.por), principal: h.principal ?? h.por } : h); }
      } else if (col === 'registro_fuentes') {
        campo('responsable'); campo('creada_por', 'creada_por_principal'); campo('modificada_por', 'modificada_por_principal'); campo('fusionada_por');
        if (Array.isArray(d.historial) && d.historial.some(h => cambia(h.por))) { d.historial.forEach(h => { if (cambia(h.por)) nota(h.por, 'historial.por'); }); set.historial = d.historial.map(h => cambia(h.por) ? { ...h, por: cambia(h.por), principal: h.principal ?? h.por } : h); }
      } else if (col === 'zonas_agentes') {
        campo('agente'); campo('asignada_por', 'asignada_por_principal');
        if (Array.isArray(d.historial) && d.historial.some(h => cambia(h.agente) || cambia(h.cambiadaPor))) set.historial = d.historial.map(h => ({ ...h, agente: cambia(h.agente) || h.agente, cambiadaPor: cambia(h.cambiadaPor) || h.cambiadaPor }));
      } else if (col === 'tablon_lecturas') {
        const canon = cambiaMayus(r.id); if (canon) { nota(r.id, 'id_documento'); cambios.push({ coleccion: col, id: canon, desde: r.id, tipo: 'fusionar_lectura', hilos: d.hilos || {} }); c.cambian++; }
        continue;
      }
      if (Object.keys(set).length) { c.cambian++; cambios.push({ coleccion: col, id: r.id, updateTime: r.updateTime, tipo: 'campos', set }); }
    }
  }
  informe.resumen = Object.fromEntries(Object.entries(informe.porColeccion).map(([k, v]) => [k, { documentos: v.documentos, cambian: v.cambian }]));
  return { informe, cambios, huella: hash(JSON.stringify(cambios.map(x => [x.coleccion, x.id, x.set ? Object.keys(x.set) : x.tipo]))).slice(0, 16) };
}
