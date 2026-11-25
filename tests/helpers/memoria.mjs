// Almacén en memoria para los tests de fiabilidad de la admisión: mismas reglas de versión que Firestore (create/updateTime), filtros eq,
// guardia del catálogo que se mueve con cada alta, e inyección de fallos (guardia ausente, pausa) sin emulador.
import { DomainError, hash } from '../../event-domain.mjs';

export const owner = { id: 'amalia-asistente', agente: 'amalia', actions: ['read', 'admit', 'review', 'board'], businesses: ['*'] };
export const alfred = { id: 'alfred', agente: 'alfred', actions: ['*'], businesses: ['*'] };
export const FUENTE_ID = 'fte_web_' + hash('editor.example/programacion').slice(0, 24);
const iso = n => new Date(1_790_000_000_000 + n * 1000).toISOString();

export class MemoryStore {
  constructor() {
    this.seq = 1; this.rows = new Map(); this.escrituras = []; this.retardoMs = 0;
    this.#put('negocios/b', { nombre: 'Negocio de ensayo' }); this.#put('amalia_catalog_guard/eventos', { epoch: 1 });
    this.#put('registro_fuentes/' + FUENTE_ID, { id: FUENTE_ID, canal: 'web', identificador: 'editor.example/programacion', url: 'https://editor.example/programacion', nombre_entidad: 'Editor de ensayo', municipio: 'Málaga', origen: 'asistente', negocio_id: null, estado: 'activa' });
  }
  #put(key, data) { this.rows.set(key, { data: structuredClone(data), updateTime: iso(++this.seq) }); }
  async #pausa() { if (this.retardoMs) await new Promise(r => setTimeout(r, this.retardoMs)); }
  async get(c, id) { await this.#pausa(); const r = this.rows.get(c + '/' + id); return r ? { id, ...structuredClone(r) } : null; }
  async list(c, { eq, limit, cursor } = {}) {
    await this.#pausa();
    let rows = [...this.rows].filter(([k]) => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/')).map(([k, r]) => ({ id: k.slice(c.length + 1), ...structuredClone(r) }));
    for (const [campo, v] of Object.entries(eq || {})) rows = rows.filter(r => r.data[campo] === v);
    rows.sort((a, b) => (a.id < b.id ? -1 : 1)); if (cursor) rows = rows.filter(r => r.id > cursor);
    return rows.slice(0, limit || 500);
  }
  async write(c, id, data, o = {}) {
    await this.#pausa(); const key = c + '/' + id, cur = this.rows.get(key);
    if (c === 'eventos' && o.create && !o.guard?.updateTime) throw new DomainError('admission_guard_required');
    if ((o.create && cur) || (!o.create && cur && o.updateTime !== cur.updateTime)) throw new DomainError('version_conflict');
    if (c === 'eventos' && o.guard) { const g = this.rows.get('amalia_catalog_guard/eventos'); if (!g || g.updateTime !== o.guard.updateTime) throw new DomainError('version_conflict'); }
    const next = o.updateFields && cur ? { ...cur.data, ...Object.fromEntries(o.updateFields.map(f => [f, data[f]])) } : structuredClone(data);
    this.#put(key, next); this.escrituras.push({ c, id });
    if (o.request) this.#put('amalia_event_requests/' + o.request.id, o.request.data);
    if (o.reserve) this.#put('amalia_event_reservations/' + o.reserve.id, o.reserve.data);
    if (c === 'eventos' && !o.metadataOnly) { const g = this.rows.get('amalia_catalog_guard/eventos'); this.#put('amalia_catalog_guard/eventos', { ...g.data, epoch: (g.data.epoch || 0) + 1 }); }
    return { id, updateTime: this.rows.get(key).updateTime };
  }
  async revisions() { return []; }
  // utilidades de test
  fuente() { return this.rows.get('registro_fuentes/' + FUENTE_ID); }
  tocarFuente() { const r = this.fuente(); this.#put('registro_fuentes/' + FUENTE_ID, { ...r.data, ultimo_evento_encontrado: String(this.seq) }); }
  pausar(v = true) { const g = this.rows.get('amalia_catalog_guard/eventos'); this.#put('amalia_catalog_guard/eventos', { ...g.data, admissionPaused: v }); }
  quitarGuardia() { this.guardiaGuardada = this.rows.get('amalia_catalog_guard/eventos'); this.rows.delete('amalia_catalog_guard/eventos'); }
  ponerGuardia() { this.rows.set('amalia_catalog_guard/eventos', { data: this.guardiaGuardada.data, updateTime: iso(++this.seq) }); }
  eventos() { return [...this.rows].filter(([k]) => k.startsWith('eventos/') && !k.slice(8).includes('/')).map(([k, r]) => ({ id: k.slice(8), ...r })); }
}
export const evento = (n = 1, o = {}) => ({ negocioId: 'b', titulo: `Concierto de ensayo número ${n} en Málaga`, descripcion: `Concierto de ensayo ${n}, solo prueba aislada local.`, city: 'Málaga', provincia: 'Málaga', pais: 'España', fechaLocal: '2099-05-' + String(1 + (n % 27)).padStart(2, '0'), horaLocal: '20:00', timeZone: 'Europe/Madrid', sesionId: 's' + n, fuentes: [{ url: `https://www.editor.example/programacion/concierto-${n}`, checkedAt: '2026-11-20T10:00:00Z' }], requestId: 'req-' + n, ...o });
export const procedencia = (store, n = 1, o = {}) => ({ version: 1, fuenteId: FUENTE_ID, fuenteVersion: store.fuente().updateTime, canalFuente: 'web', identificadorCanonico: 'editor.example/programacion', urlPrimaria: evento(n).fuentes[0].url, evidenciaEditorial: { responsable: 'Revisor editorial', verificadoEn: '2026-11-06T15:00:00Z', relacion: 'La sección oficial del editor enlaza esta actividad', urls: ['https://editor.example/quienes'], observacion: 'Comprobación editorial documentada para ensayo' }, canalEntrada: { canal: 'EMAIL', referencia: 'mensaje-ensayo' }, ...o });
export const capturaLog = () => { const lineas = [], orig = console.error; console.error = (...a) => { lineas.push(a.map(String).join(' ')); }; return { lineas, restaurar: () => { console.error = orig; } }; };
