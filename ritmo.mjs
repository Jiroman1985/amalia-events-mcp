// ritmo.mjs — objetivos de altas por agente y umbrales de vigilancia. Solo configuración pura (sin E/S).
/** Altas por DÍA que se espera de cada agente con objetivo (horasEfectivas = horas de trabajo reales al día). */
export const OBJETIVOS_DEFECTO = { amalia: { min: 100, max: 200, horasEfectivas: 10 } };
export const SIN_ALTAS_MS = () => Number(process.env.AMALIA_ALERTA_SIN_ALTAS_MS || 2 * 3600 * 1000);
export const ERRORES_REPETIDOS_N = () => Number(process.env.AMALIA_ALERTA_ERRORES_N || 3);
export const ERRORES_VENTANA_MS = () => Number(process.env.AMALIA_ALERTA_ERRORES_VENTANA_MS || 15 * 60 * 1000);
/** AMALIA_OBJETIVOS_ALTAS='{"amalia":{"min":100,"max":200,"horasEfectivas":10}}' sustituye los objetivos; si no es válido se usan los de por defecto (con aviso en el log). */
export function objetivos(env = process.env.AMALIA_OBJETIVOS_ALTAS, log = m => console.error(m)) {
  if (!env) return structuredClone(OBJETIVOS_DEFECTO);
  try {
    const o = JSON.parse(env), out = {};
    for (const [a, v] of Object.entries(o)) { if (!/^[a-z0-9_-]{2,40}$/.test(a) || !(v.min >= 0) || !(v.max >= v.min)) throw new Error('objetivo_invalido'); out[a] = { min: v.min, max: v.max, horasEfectivas: v.horasEfectivas > 0 ? v.horasEfectivas : 10 }; }
    return out;
  } catch { log(JSON.stringify({ level: 'warn', event: 'objetivos_altas_invalidos', aviso: 'AMALIA_OBJETIVOS_ALTAS no es válido: se usan los objetivos por defecto.' })); return structuredClone(OBJETIVOS_DEFECTO); }
}
