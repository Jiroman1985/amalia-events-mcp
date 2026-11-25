// carga_admision.mjs — prueba de carga de la admisión con N agentes escribiendo a la vez contra el almacén en memoria con latencia simulada
// (no hay emulador de Firestore en este servidor: la latencia de red se simula con --retardo-ms por operación del almacén).
//   node carga_admision.mjs [--minutos 10] [--agentes 3] [--retardo-ms 25] [--ritmo-ms 0] [--externo-ms 0] [--salida informe.json]
// --externo-ms N: un escritor EXTERNO (fuera de este proceso: otro servidor, un script) crea un evento cada N ms y mueve la guardia: es la única fuente real de contención.
// Mide altas/hora, reintentos por contención de la guardia (version_conflict) y la tasa de admission_contended que llega al agente (encolada o error).
import { writeFileSync } from 'node:fs';
import { EventService } from './event-service.mjs';
import { DomainError } from './event-domain.mjs';
import { MemoryStore } from './tests/helpers/memoria.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : Number(process.argv[i + 1]); };
const MIN = arg('minutos', 10), AGENTES = arg('agentes', 3), RETARDO = arg('retardo-ms', 25), RITMO = arg('ritmo-ms', 0), EXTERNO = arg('externo-ms', 0);
const salida = (() => { const i = process.argv.indexOf('--salida'); return i < 0 ? null : process.argv[i + 1]; })();
const store = new MemoryStore(); store.retardoMs = RETARDO;
let conflictos = 0; const w = store.write.bind(store);
store.write = async (c, id, d, o = {}) => { try { return await w(c, id, d, o); } catch (e) { if (c === 'eventos' && o.create && e.code === 'version_conflict') conflictos++; throw e; } };
console.error = () => {}; // sin ruido de logs
const s = new EventService(store, {}, { warm: false, cola: true, registryCutoff: '2026-11-22T00:00:00Z', plazoLlamadaMs: 20000 });
const P = ['festival', 'concierto', 'teatro', 'ruta', 'taller', 'mercado', 'feria', 'jornada', 'cata', 'exposicion', 'danza', 'cine', 'charla', 'romeria', 'verbena', 'carrera', 'torneo', 'visita', 'curso', 'homenaje', 'certamen', 'muestra', 'gala', 'recital', 'maraton', 'degustacion', 'pregon', 'procesion', 'encuentro', 'semana'];
const T = ['del olivo', 'de la luna', 'del rio', 'de los caminos', 'de otoño', 'del vino', 'de la sierra', 'del pan', 'del agua', 'de las flores', 'del aceite', 'del castillo', 'del patrimonio', 'de la memoria', 'del mar'];
const CIUDADES = ['Córdoba', 'Sevilla', 'Málaga', 'Granada', 'Jaén', 'Almería', 'Huelva', 'Cádiz', 'Antequera', 'Ronda', 'Úbeda', 'Baeza', 'Lucena', 'Écija', 'Osuna', 'Marbella', 'Motril', 'Guadix', 'Priego', 'Loja'];
let contador = 0;
const nuevo = (ag) => { const n = ++contador, d = new Date(Date.UTC(2099, 0, 1 + (n * 7) % 330)).toISOString().slice(0, 10), ciu = CIUDADES[n % CIUDADES.length]; return { negocioId: 'b', titulo: `${P[n % P.length]} ${T[(n * 3) % T.length]} de ${ciu} edición ${n}`, descripcion: `Evento de ensayo de carga número ${n}.`, city: ciu, provincia: ciu, pais: 'España', fechaLocal: d, horaLocal: `${String(10 + (n % 12)).padStart(2, '0')}:00`, timeZone: 'Europe/Madrid', sesionId: `c${n}`, fuentes: [{ url: `https://carga.example/${ag}/evento-${n}`, checkedAt: '2026-11-20T10:00:00Z' }], requestId: `carga-${ag}-${n}` }; };
const r = { admitidos: 0, omitidos: 0, encolados: 0, errores: {}, contendidasAlAgente: 0, ms: [], represadas: 0 };
const fin = Date.now() + MIN * 60 * 1000, p = i => ({ id: 'agente-' + i, agente: 'agente-' + i, actions: ['admit', 'read'], businesses: ['*'] });
async function agente(i) {
  const pr = p(i);
  while (Date.now() < fin) {
    const ev = nuevo(i), t0 = Date.now();
    try {
      const prep = await s.conCola('preparar', ev, pr, () => s.prepareAdmission(ev, pr));
      if (prep.encolado) { r.encolados++; if (prep.motivo === 'admission_contended') r.contendidasAlAgente++; continue; }
      if (!prep.admisible) { r.omitidos++; continue; }
      const a = await s.conCola('admitir', prep.evento, pr, () => s.admitCandidate({ accion: 'admit', proposalHash: prep.proposalHash, evento: prep.evento, huellaCampos: prep.huellaCampos }, pr));
      if (a.encolado) { r.encolados++; if (a.motivo === 'admission_contended') r.contendidasAlAgente++; } else { r.admitidos++; if (a.represado) r.represadas++; r.ms.push(Date.now() - t0); }
    } catch (e) { const c = e instanceof DomainError ? e.code : 'otro'; r.errores[c] = (r.errores[c] || 0) + 1; if (c === 'admission_contended') r.contendidasAlAgente++; }
    if (RITMO) await new Promise(res => setTimeout(res, RITMO));
  }
}
let externos = 0;
const ext = EXTERNO ? setInterval(async () => { try { const g = await store.get('amalia_catalog_guard', 'eventos'); await w('eventos', 'ext_' + (++externos), { titulo: 'externo ' + externos, retirado: false, fechaLocal: '2098-01-01' }, { create: true, guard: { updateTime: g.updateTime, epoch: g.data.epoch } }); } catch { /* otro escritor ganó */ } }, EXTERNO) : null;
const t0 = Date.now(); await Promise.all(Array.from({ length: AGENTES }, (_, i) => agente(i + 1)));
if (ext) clearInterval(ext);
const dur = (Date.now() - t0) / 3600000, ms = r.ms.sort((a, b) => a - b), intentos = r.admitidos + r.omitidos + r.encolados + Object.values(r.errores).reduce((a, b) => a + b, 0);
const informe = { minutos: MIN, agentes: AGENTES, retardoMsPorOperacion: RETARDO, ritmoMs: RITMO, escritorExternoCadaMs: EXTERNO, escriturasExternas: externos, altasAdmitidas: r.admitidos, altasPorHoraTotal: Math.round(r.admitidos / dur), altasPorHoraYAgente: Math.round(r.admitidos / dur / AGENTES), omitidos: r.omitidos, encolados: r.encolados, errores: r.errores, intentosDeAlta: intentos, reintentosPorContencionDeGuardia: conflictos, tasaReintentoContencion: +(conflictos / Math.max(1, intentos)).toFixed(4), admissionContendedAlAgente: r.contendidasAlAgente, tasaAdmissionContended: +(r.contendidasAlAgente / Math.max(1, intentos)).toFixed(4), represadas: r.represadas, latenciaAltaMs: { media: Math.round(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length)), p95: ms[Math.floor(ms.length * 0.95)] ?? null, max: ms.at(-1) ?? null }, eventosPropios: store.eventos().filter(e => !e.id.startsWith('ext_')).length };
if (salida) writeFileSync(salida, JSON.stringify(informe, null, 1));
process.stdout.write(JSON.stringify(informe, null, 1) + '\n');
