// catalogo-service.mjs — capa derivada `catalogo_amalia_v1` (categoría, ubicación, fechas y visibilidad).
//
// - ADITIVA: no modifica ningún campo original del evento; solo escribe `catalogo_amalia_v1` (y, en una revisión
//   manual, `catalogo_revision`). Los valores anteriores se guardan en `eventos_catalogo_cambios` y cada tanda
//   en `eventos_catalogo_runs`.
// - SIMULAR primero: `aplicar` exige el código de confirmación de ese mismo lote; si los datos cambian entre
//   medias, el código ya no coincide y hay que volver a simular.
// - REANUDABLE e idempotente: se compara antes de escribir (un evento ya al día no se toca), el registro de
//   cambios usa una clave determinista y cada escritura lleva precondición de versión.
import { authorize, fail, fingerprint, hash, id } from './event-domain.mjs';
import { calcularCatalogo, catalogoVigente, pendientesDe, contarRepetidos, resolverValorCategoria, nombreDeCategoria, validarPar, CAMPO_CATALOGO, CAMPO_REVISION } from './catalogo-compartido.mjs';

const hoyMadrid = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);
const TIPOS = ['recinto', 'direccion_aproximada', 'municipio'];
/** Clave del registro de cambios: determinista y siempre ≤ 128 caracteres (un id de evento largo + el id de la tanda se pasaba). */
const claveCambio = (prefijo, eventId, sufijo = '') => {
  const k = `${prefijo}__${eventId}${sufijo}`;
  return k.length <= 128 ? k : `${prefijo}__h_${hash(eventId).slice(0, 40)}${sufijo}`;
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lo que se compara y se guarda en el registro de cambios (sin la marca de tiempo del cálculo). */
export const resumen = (c) => c && ({
  categoria: { id: c.categoria.id, estado: c.categoria.estado, motivo: c.categoria.motivo, alternativas: c.categoria.alternativas },
  ubicacion: { tipo: c.ubicacion.tipo, verificacion: c.ubicacion.verificacion, motivo: c.ubicacion.motivo, lat: c.ubicacion.lat, lng: c.ubicacion.lng, fuentes: c.ubicacion.fuentes },
  fechas: { inicio: c.fechas.inicio, fin: c.fechas.fin, tipo: c.fechas.tipo, motivo: c.fechas.motivo },
  visibilidad: c.visibilidad,
});

export class CatalogoService {
  constructor(store, { pausaMs = 150 } = {}) { this.store = store; this.pausaMs = pausaMs; }

  /** Estas operaciones abarcan TODO el catálogo (todos los negocios): no basta la acción, la cuenta debe ser global. */
  #autorizar(principal, accion) {
    authorize(principal, null, accion);
    if (!principal.businesses.includes('*')) fail('business_forbidden', { ayuda: 'Esta operación abarca todo el catálogo: exige una cuenta global (negocios: *).' });
  }

  async #todos() {
    const rows = [];
    let cursor = null;
    for (let i = 0; i < 80; i++) {
      const page = await this.store.list('eventos', { limit: 300, cursor });
      rows.push(...page);
      if (page.length < 300) return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      cursor = page.at(-1).id;
    }
    fail('incomplete_scan', { ayuda: 'El catálogo supera el tope de lectura; no se aplica nada a ciegas.' });
  }

  #evaluar(rows) {
    const hoy = hoyMadrid(), ahora = new Date().toISOString();
    const repetidos = contarRepetidos(rows.map((r) => r.data));
    return rows.map((row) => {
      const nuevo = calcularCatalogo(row.data, { hoy, ahora, repetidos });
      const previo = row.data[CAMPO_CATALOGO] ?? null;
      const retirado = row.data.retirado === true;
      const cambia = !retirado && (!previo || previo.entradaHash !== nuevo.entradaHash || JSON.stringify(resumen(previo)) !== JSON.stringify(resumen(nuevo)));
      return { row, nuevo, previo, retirado, cambia };
    });
  }

  async classify({ modo = 'simular', runId, limite = 100, muestras = 10, codigoConfirmacion } = {}, principal) {
    this.#autorizar(principal, 'classify');
    if (!['simular', 'aplicar'].includes(modo)) fail('invalid_mode');
    if (!Number.isInteger(limite) || limite < 1 || limite > 300) fail('invalid_limit');
    const evaluados = this.#evaluar(await this.#todos());
    const aCambiar = evaluados.filter((e) => e.cambia);
    const lote = aCambiar.slice(0, limite);
    const codigo = fingerprint({ lote: lote.map((e) => [e.row.id, e.row.updateTime, JSON.stringify(resumen(e.nuevo))]) }).slice(0, 12);
    const cuenta = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
    const vivos = evaluados.filter((e) => !e.retirado);
    const informe = {
      totales: { documentos: evaluados.length, retirados: evaluados.length - vivos.length, aCambiar: aCambiar.length, alDia: vivos.length - aCambiar.length },
      categorias: cuenta(vivos, (e) => e.nuevo.categoria.id ?? 'REVISION'),
      ubicacion: cuenta(vivos, (e) => `${e.nuevo.ubicacion.tipo}/${e.nuevo.ubicacion.verificacion}`),
      pendientesRevision: {
        categoria: { total: vivos.filter((e) => e.nuevo.categoria.estado === 'revision').length, muestras: vivos.filter((e) => e.nuevo.categoria.estado === 'revision').slice(0, muestras).map((e) => ({ eventId: e.row.id, titulo: e.row.data.nombre ?? e.row.data.titulo ?? null, original: e.nuevo.categoria.original, motivo: e.nuevo.categoria.motivo, alternativas: e.nuevo.categoria.alternativas.map(nombreDeCategoria) })) },
        ubicacion: { total: vivos.filter((e) => e.nuevo.ubicacion.verificacion === 'discrepante').length, muestras: vivos.filter((e) => e.nuevo.ubicacion.verificacion === 'discrepante').slice(0, muestras).map((e) => ({ eventId: e.row.id, titulo: e.row.data.nombre ?? e.row.data.titulo ?? null, avisos: e.nuevo.ubicacion.avisos })) },
      },
    };
    if (modo === 'simular') {
      return { modo, ...informe, lote: { tamano: lote.length, codigoConfirmacion: codigo }, siguientePaso: lote.length ? `clasificar_catalogo con modo=aplicar, runId=<nuevo id> y codigoConfirmacion=${codigo}` : 'Nada que aplicar: el catálogo está al día.' };
    }
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(runId)) fail('run_id_required');
    if (codigoConfirmacion !== codigo) fail('confirmation_mismatch', { ayuda: 'Los datos cambiaron o el código no es del lote actual: vuelve a simular.' });
    if (!lote.length) return { modo, runId, aplicados: 0, conflictos: 0, errores: [], restantes: 0, siguientePaso: 'Catálogo al día: no se ha escrito nada.', totales: informe.totales };
    const por = principal.id, en = new Date().toISOString();
    let aplicados = 0, conflictos = 0;
    const errores = [];
    for (const e of lote) {
      try {
        // 1) registro de cambios (clave determinista: reintentar no duplica)
        try {
          await this.store.write('eventos_catalogo_cambios', claveCambio(runId, e.row.id), { runId, eventId: e.row.id, antes: resumen(e.previo), despues: resumen(e.nuevo), entradaHash: e.nuevo.entradaHash, por, en }, { create: true });
        } catch (err) { if (err.code !== 'version_conflict') throw err; }
        // 2) escritura parcial del campo derivado, con precondición de versión
        await this.store.write('eventos', e.row.id, { [CAMPO_CATALOGO]: e.nuevo }, { updateTime: e.row.updateTime, updateFields: [CAMPO_CATALOGO] });
        aplicados++;
      } catch (err) {
        if (err.code === 'version_conflict') conflictos++; else errores.push({ eventId: e.row.id, error: err.code || String(err.message).slice(0, 80) });
      }
      if (this.pausaMs) await dormir(this.pausaMs);
    }
    await this.#anotarRun(runId, { aplicados, conflictos, errores: errores.length }, por, en);
    return { modo, runId, aplicados, conflictos, errores, restantes: Math.max(0, aCambiar.length - aplicados), siguientePaso: aCambiar.length - aplicados > 0 ? 'Repite simular y aplicar con el mismo runId hasta que restantes sea 0.' : 'Catálogo al día.', totales: informe.totales };
  }

  async #anotarRun(runId, delta, por, en) {
    const prev = await this.store.get('eventos_catalogo_runs', id(runId));
    const data = prev
      ? { ...prev.data, aplicados: (prev.data.aplicados ?? 0) + delta.aplicados, conflictos: (prev.data.conflictos ?? 0) + delta.conflictos, errores: (prev.data.errores ?? 0) + delta.errores, tandas: (prev.data.tandas ?? 0) + 1, actualizadoEn: en }
      : { runId, por, empezadoEn: en, actualizadoEn: en, tandas: 1, ...delta };
    await this.store.write('eventos_catalogo_runs', id(runId), data, prev ? { updateTime: prev.updateTime } : { create: true });
  }

  /** Resuelve a mano un caso en revisión (categoría y/o ubicación). La revisión manda sobre lo automático. */
  async review({ eventId, categoria, ubicacion, motivo }, principal) {
    this.#autorizar(principal, 'classify');
    if (typeof motivo !== 'string' || motivo.trim().length < 3 || motivo.length > 500) fail('reason_required');
    if (categoria == null && ubicacion == null) fail('nothing_to_review');
    const row = await this.store.get('eventos', id(eventId));
    if (!row) fail('event_not_found');
    if (row.data.retirado === true) fail('event_retired', { eventId });
    const en = new Date().toISOString();
    const rev = { ...(row.data[CAMPO_REVISION] ?? {}), por: principal.id, en, motivo: motivo.trim() };
    if (categoria != null) {
      const r = resolverValorCategoria(categoria);
      if (r.tipo !== 'id') fail('unknown_category', { categoria, validas: 'las 8 categorías oficiales' });
      rev.categoria = r.id;
    }
    if (ubicacion != null) {
      const v = validarPar(ubicacion.lat, ubicacion.lng);
      if (!v.ok) fail('invalid_coordinates', { motivo: v.motivo });
      if (!TIPOS.includes(ubicacion.tipo)) fail('location_type_required', { validos: TIPOS });
      if (typeof ubicacion.fuente !== 'string' || ubicacion.fuente.trim().length < 3) fail('location_source_required');
      rev.ubicacion = { lat: v.par.lat, lng: v.par.lng, tipo: ubicacion.tipo, fuente: ubicacion.fuente.trim(), comprobadoEn: en };
    }
    const doc = { ...row.data, [CAMPO_REVISION]: rev };
    const nuevo = calcularCatalogo(doc, { hoy: hoyMadrid(), ahora: en });
    await this.store.write('eventos_catalogo_cambios', claveCambio('rev', row.id, '__' + en.replace(/[^0-9]/g, '')), { eventId: row.id, tipo: 'revision_manual', antes: { revision: row.data[CAMPO_REVISION] ?? null, catalogo: resumen(row.data[CAMPO_CATALOGO] ?? null) }, despues: { revision: rev, catalogo: resumen(nuevo) }, por: principal.id, en }, { create: true });
    await this.store.write('eventos', row.id, { [CAMPO_REVISION]: rev, [CAMPO_CATALOGO]: nuevo }, { updateTime: row.updateTime, updateFields: [CAMPO_REVISION, CAMPO_CATALOGO] });
    return { eventId: row.id, revision: rev, catalogo: resumen(nuevo) };
  }

  /** Lista de pendientes: lo visible y no pasado que necesita que alguien decida (ubicación, categoría o fecha). */
  async pending({ tipo = 'todos', soloEnVentana = false, limite = 100, desde = 0 } = {}, principal) {
    this.#autorizar(principal, 'read');
    if (!['todos', 'ubicacion', 'categoria', 'fecha'].includes(tipo)) fail('invalid_type');
    if (!Number.isInteger(limite) || limite < 1 || limite > 300 || !Number.isInteger(desde) || desde < 0) fail('invalid_limit');
    const rows = await this.#todos(), hoy = hoyMadrid(), ahora = new Date().toISOString();
    const repetidos = contarRepetidos(rows.map((r) => r.data));
    const COMO = {
      ubicacion: 'revisar_catalogo con ubicacion {lat, lng, tipo: recinto|direccion_aproximada|municipio, fuente}; si es un evento gestionado, también editar_evento con geoUbicacion',
      categoria: 'revisar_catalogo con categoria (una de las 8 oficiales) y motivo',
      fecha: 'Sin fecha concreta el evento no se publica: aportar una fecha verificada (editar_evento si es un evento gestionado)',
    };
    const items = [], porTipo = {}, porMotivo = {};
    for (const row of rows) {
      const { catalogo: c } = catalogoVigente(row.data, { hoy, ahora, repetidos });
      for (const p of pendientesDe(c, hoy)) {
        if (tipo !== 'todos' && p.tipo !== tipo) continue;
        if (soloEnVentana && !p.enVentana) continue;
        porTipo[p.tipo] = (porTipo[p.tipo] ?? 0) + 1;
        const clave = `${p.tipo}:${p.motivo}`; porMotivo[clave] = (porMotivo[clave] ?? 0) + 1;
        const d = row.data;
        items.push({ eventId: row.id, negocioId: d.negocioId ?? null, titulo: d.nombre ?? d.titulo ?? null, ciudad: d.ciudad ?? d.city ?? null, fechaInicio: c.fechas.inicio, textoFechaOriginal: [d.dateTime, d.fecha, d.fecha_inicio].find((v) => typeof v === 'string' && v.trim())?.slice(0, 100) ?? null, origen: d.source ?? null, pendiente: { tipo: p.tipo, motivo: p.motivo, detalle: p.detalle ?? [], enVentana: p.enVentana }, comoResolver: COMO[p.tipo] });
      }
    }
    items.sort((a, b) => (b.pendiente.enVentana - a.pendiente.enVentana) || ((a.fechaInicio ?? '9') < (b.fechaInicio ?? '9') ? -1 : 1) || (a.eventId < b.eventId ? -1 : 1));
    return { fecha: hoy, total: items.length, porTipo, porMotivo, desde, devueltos: Math.min(limite, Math.max(0, items.length - desde)), siguienteDesde: desde + limite < items.length ? desde + limite : null, items: items.slice(desde, desde + limite) };
  }
}
