// ritmo.mjs — objetivos de altas por agente y umbrales de vigilancia. Solo configuración pura (sin E/S).
/** Altas por DÍA que se espera de cada agente con objetivo (horasEfectivas = horas de trabajo reales al día). */
export const OBJETIVOS_DEFECTO = { amalia: { min: 100, max: 200, horasEfectivas: 10 } };
export const SIN_ALTAS_MS = () => Number(process.env.AMALIA_ALERTA_SIN_ALTAS_MS || 2 * 3600 * 1000);
export const ERRORES_REPETIDOS_N = () => Number(process.env.AMALIA_ALERTA_ERRORES_N || 3);
export const ERRORES_VENTANA_MS = () => Number(process.env.AMALIA_ALERTA_ERRORES_VENTANA_MS || 15 * 60 * 1000);
/** Turno en que se espera que un agente dé altas (hora de Madrid), «8-22» = de 08:00 a 22:00. Fuera de turno el reloj de «sin altas» no avanza y no se abren alertas de ritmo. AMALIA_TURNO_ALTAS lo cambia; un objetivo puede traer su propio "turno". */
export const TURNO_DEFECTO = { desde: 8, hasta: 22 };
export function parseTurno(v, log = m => console.error(m)) {
  if (v == null || v === '') return { ...TURNO_DEFECTO };
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(v));
  if (m && +m[1] <= 24 && +m[2] <= 24 && +m[1] !== +m[2]) return { desde: +m[1], hasta: +m[2] };
  log(JSON.stringify({ level: 'warn', event: 'turno_altas_invalido', valor: String(v).slice(0, 20), aviso: 'AMALIA_TURNO_ALTAS no es válido (usa «8-22»): se usa 8-22.' })); return { ...TURNO_DEFECTO };
}
export const turnoDe = (obj) => parseTurno(obj?.turno ?? process.env.AMALIA_TURNO_ALTAS);
const horaMadrid = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: 'numeric', hourCycle: 'h23' });
export const enTurno = (ms, turno = turnoDe()) => { const h = Number(horaMadrid.format(ms)) % 24; return turno.desde < turno.hasta ? h >= turno.desde && h < turno.hasta : h >= turno.desde || h < turno.hasta; };
/** Minutos de turno entre dos instantes (paso de 5 min: error < 5 min). */
export function minutosLaborables(desdeMs, hastaMs, turno = turnoDe()) {
  let min = 0; for (let t = desdeMs; t < hastaMs; t += 300000) if (enTurno(t, turno)) min += Math.min(300000, hastaMs - t) / 60000;
  return Math.round(min);
}
/** AMALIA_OBJETIVOS_ALTAS='{"amalia":{"min":100,"max":200,"horasEfectivas":10}}' sustituye los objetivos; si no es válido se usan los de por defecto (con aviso en el log). */
export function objetivos(env = process.env.AMALIA_OBJETIVOS_ALTAS, log = m => console.error(m)) {
  if (!env) return structuredClone(OBJETIVOS_DEFECTO);
  try {
    const o = JSON.parse(env), out = {};
    for (const [a, v] of Object.entries(o)) { if (!/^[a-z0-9_-]{2,40}$/.test(a) || !(v.min >= 0) || !(v.max >= v.min)) throw new Error('objetivo_invalido'); out[a] = { min: v.min, max: v.max, horasEfectivas: v.horasEfectivas > 0 ? v.horasEfectivas : 10, ...(v.turno ? { turno: v.turno } : {}) }; }
    return out;
  } catch { log(JSON.stringify({ level: 'warn', event: 'objetivos_altas_invalidos', aviso: 'AMALIA_OBJETIVOS_ALTAS no es válido: se usan los objetivos por defecto.' })); return structuredClone(OBJETIVOS_DEFECTO); }
}
