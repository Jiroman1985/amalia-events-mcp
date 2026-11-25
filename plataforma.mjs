// plataforma.mjs — qué errores son de CONFIGURACIÓN o de PLATAFORMA (reintentables, no culpa de los datos) y un monitor en memoria
// con latencias y errores recientes. Un error de datos (p. ej. registro_primary_mismatch) NO está aquí: bloquea ese evento concreto.
import { DomainError } from './event-domain.mjs';

/** Fallos de configuración: el alta se degrada (procedencia) o se encola, nunca deja al agente parado. */
export const CODIGOS_CONFIG = new Set(['registro_cutoff_unconfigured', 'registro_cutoff_not_reached', 'catalog_guard_unavailable', 'admission_paused']);
/** Fallos de plataforma reintentables (carga, tiempo, contención, red). */
export const CODIGOS_PLATAFORMA = new Set([...CODIGOS_CONFIG, 'operation_timeout', 'catalog_load_timeout', 'admission_contended', 'incomplete_scan', 'backend_auth_failed', 'plataforma_no_disponible']);
const HTTP_RETRY = /^firestore_http_(5\d\d|429)$/;

/** {codigo, reintentable, config}: errores de red/tiempo no tipados cuentan como plataforma_no_disponible. */
export function clasifica(e) {
  if (e instanceof DomainError) return { codigo: e.code, reintentable: CODIGOS_PLATAFORMA.has(e.code) || HTTP_RETRY.test(e.code), config: CODIGOS_CONFIG.has(e.code) };
  const n = String(e?.name || ''), c = String(e?.code || '');
  const red = /^(TimeoutError|AbortError)$/.test(n) || /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(c) || /fetch failed/i.test(String(e?.message || ''));
  return red ? { codigo: 'plataforma_no_disponible', reintentable: true, config: false } : { codigo: 'operation_failed', reintentable: false, config: false };
}

const VENTANA_MS = 24 * 3600 * 1000;
export class MonitorPlataforma {
  constructor({ ahora = () => Date.now() } = {}) { this.ahora = ahora; this.errores = []; this.lat = { preparar: [], admitir: [] }; this.altas = []; }
  #poda() { const t = this.ahora() - VENTANA_MS; while (this.errores.length && this.errores[0].t < t) this.errores.shift(); while (this.altas.length && this.altas[0].t < t) this.altas.shift(); if (this.errores.length > 5000) this.errores.splice(0, this.errores.length - 5000); if (this.altas.length > 20000) this.altas.splice(0, this.altas.length - 20000); }
  error(agente, codigo, accion = null) { this.errores.push({ t: this.ahora(), agente, codigo, accion }); this.#poda(); }
  alta(agente) { this.altas.push({ t: this.ahora(), agente }); this.#poda(); }
  latencia(op, ms) { const l = this.lat[op] || (this.lat[op] = []); l.push(ms); if (l.length > 200) l.shift(); }
  erroresDesde(ms, { agente = null } = {}) { const t = this.ahora() - ms, out = {}; for (const x of this.errores) if (x.t >= t && (!agente || x.agente === agente)) out[x.codigo] = (out[x.codigo] || 0) + 1; return out; }
  /** Veces que un agente ha tenido ese error en la ventana. */
  repeticiones(agente, codigo, ms) { const t = this.ahora() - ms; return this.errores.filter(x => x.t >= t && x.agente === agente && x.codigo === codigo).length; }
  ultimoError(agente, codigo) { return this.errores.filter(x => x.agente === agente && x.codigo === codigo).at(-1)?.t ?? null; }
  agentesConErrores(ms) { const t = this.ahora() - ms; return [...new Set(this.errores.filter(x => x.t >= t).map(x => x.agente))]; }
  codigosDe(agente, ms) { const t = this.ahora() - ms; return [...new Set(this.errores.filter(x => x.t >= t && x.agente === agente).map(x => x.codigo))]; }
  ultimaAlta(agente) { return this.altas.filter(x => x.agente === agente).at(-1)?.t ?? null; }
  resumenLatencia(op) { const l = [...(this.lat[op] || [])].sort((a, b) => a - b); if (!l.length) return { n: 0, mediaMs: null, p95Ms: null, maxMs: null }; return { n: l.length, mediaMs: Math.round(l.reduce((a, b) => a + b, 0) / l.length), p95Ms: l[Math.min(l.length - 1, Math.floor(l.length * 0.95))], maxMs: l.at(-1) }; }
}
