// reparacion-url.mjs — detección PURA de url_normalizada incoherente con la url propia de la fuente (error de la migración de la hoja: copió la URL de la columna URL).
import { normalizarUrl } from './fuentes-modelo.mjs';
const host = k => String(k || '').split('/')[0].split('?')[0];
/** Valor correcto de url_normalizada, o null si el actual ya es coherente. Instagram (y otros perfiles): debe ser exactamente la normalización de su url. Resto: se corrige solo si el dominio no coincide con el de la url (los parámetros de identidad legítimos se respetan). */
export function urlNormalizadaCorrecta(d) {
  if (d.url_normalizada == null) return null;                  // sin valor guardado: se calcula al vuelo desde la url
  const propia = normalizarUrl(d.url); if (!propia) return null;
  if (d.canal === 'instagram' || d.canal === 'tiktok') return d.url_normalizada === propia ? null : propia;
  return host(d.url_normalizada) === host(propia) ? null : propia;
}
export function planReparacionUrl(rows, solo = null) {
  const items = rows.filter(r => !solo || r.id === solo).map(r => ({ r, nuevo: urlNormalizadaCorrecta(r.data) })).filter(x => x.nuevo)
    .map(({ r, nuevo }) => ({ fuenteId: r.id, canal: r.data.canal, url: r.data.url, antes: r.data.url_normalizada, despues: nuevo, updateTime: r.updateTime }));
  const porCanal = {}; for (const i of items) porCanal[i.canal] = (porCanal[i.canal] || 0) + 1;
  return { total: items.length, porCanal, items };
}

/** Instagram con url_normalizada ausente: se rellena con instagram.com/<usuario> (solo si url e identificador son coherentes; el resto se omite y se informa). */
export function planRelleno(rows) {
  const items = [], omitidas = [];
  for (const r of rows) {
    const d = r.data; if (d.canal !== 'instagram' || d.url_normalizada != null) continue;
    const h = String(d.identificador || '').toLowerCase().trim();
    if (!h || d.url !== `https://www.instagram.com/${h}/`) { omitidas.push({ fuenteId: r.id, identificador: d.identificador ?? null, url: d.url ?? null }); continue; }
    items.push({ fuenteId: r.id, codigo: d.codigo ?? null, identificador: h, valor: `instagram.com/${h}` });
  }
  return { total: items.length, items, omitidas };
}
