// auditoria-duplicados.mjs — análisis puro de duplicados sobre el catálogo (job nocturno y ensayos). No escribe nada.
import { claveSesion, clavesDeEvento, decidirSesion, tituloParecido, tituloIgual, sesionesDeEvento, recintosCompatibles } from './clave-sesion.mjs';
import { leg } from './dedup_amalia.mjs';

/** Puntuación de completitud para elegir la ficha que se conserva. */
export function completitud(d) {
  const llenos = ['descripcion', 'direccion', 'lugar', 'horaLocal', 'precioInfo', 'categorias', 'etiquetas', 'geoUbicacion'].filter(k => { const v = d[k]; return v != null && v !== '' && !(Array.isArray(v) && !v.length); }).length;
  return llenos + (d.assetId || d.image ? 3 : 0) + (d.fuenteId ? 1 : 0) + Math.min((d.fuentes || []).length, 3) + (Array.isArray(d.sesiones) ? d.sesiones.length : 0) + (d.verificationStatus === 'verificado' ? 2 : 0);
}
export function elegirConservada(a, b) {
  const ca = completitud(a.data), cb = completitud(b.data);
  if (ca !== cb) return ca > cb ? [a, b] : [b, a];
  return (a.data.fechaCreacion || '') <= (b.data.fechaCreacion || '') ? [a, b] : [b, a];
}
/** rows: [{id,data}]. Devuelve exactos (seguros), dudosos y choques por clave fuerte con título distinto. */
export function analizarDuplicados(rows, { prueba = false } = {}) {
  const porId = new Map(), items = [];
  for (const r of rows) {
    const d = r.data || {};
    if (d.retirado === true || (d.prueba === true) !== prueba) continue;
    porId.set(r.id, r);
    for (const c of clavesDeEvento(r.id, d)) items.push({ ...c.data, titulo: leg(d, 'titulo', 'nombre') || '', tituloOriginal: leg(d, 'titulo', 'nombre') || '', claveId: c.id });
  }
  const buckets = new Map();
  for (const i of items) (buckets.get(i.municipioFecha) || buckets.set(i.municipioFecha, []).get(i.municipioFecha)).push(i);
  const pares = new Map();
  for (const g of buckets.values()) for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) {
    const x = g[a], y = g[b]; if (x.eventId === y.eventId) continue;
    const dec = decidirSesion(x, [y]); if (dec.decision === 'libre') continue;
    const k = [x.eventId, y.eventId].sort().join('>'); const cur = pares.get(k);
    if (!cur || (dec.decision === 'bloquea' && cur.decision !== 'bloquea')) pares.set(k, { a: x.eventId, b: y.eventId, decision: dec.decision, motivos: dec.motivos.map(m => m.motivo), clave: x.clave, fuerte: x.fuerza === 'fuerte' && y.fuerza === 'fuerte' });
  }
  // Temporadas (rangos de más de 31 días): cualquier sesión del mismo municipio y recinto DENTRO del rango con título parecido es dudosa.
  const temporadas = items.filter(i => i.fuerza === 'temporada'), sueltas = items.filter(i => i.fuerza !== 'temporada');
  for (const t of temporadas) {
    if (!t.recinto) continue;
    for (const x of [...sueltas, ...temporadas]) {
      if (x.eventId === t.eventId || x.municipio !== t.municipio || !x.recinto || !recintosCompatibles(t.recinto, x.recinto)) continue;
      const dentro = x.fuerza === 'temporada' ? (x.fecha <= t.fechaFin && x.fechaFin >= t.fecha) : (x.fecha >= t.fecha && x.fecha <= t.fechaFin);
      if (!dentro || !tituloParecido(t.tituloOriginal, x.tituloOriginal)) continue;
      const k = [t.eventId, x.eventId].sort().join('>'); if (!pares.has(k)) pares.set(k, { a: t.eventId, b: x.eventId, decision: 'cola', motivos: ['dentro_de_temporada'], clave: t.clave, fuerte: false });
    }
  }
  const exactos = [], dudosos = [];
  for (const p of pares.values()) {
    const A = porId.get(p.a), B = porId.get(p.b);
    const seguro = p.decision === 'bloquea' && p.fuerte && tituloParecido(leg(A.data, 'titulo', 'nombre'), leg(B.data, 'titulo', 'nombre'));
    (seguro ? exactos : dudosos).push({ ...p, titulos: [leg(A.data, 'titulo', 'nombre'), leg(B.data, 'titulo', 'nombre')] });
  }
  return { exactos, dudosos, sesiones: items.length, eventos: porId.size };
}
