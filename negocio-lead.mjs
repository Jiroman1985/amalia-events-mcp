// negocio-lead.mjs — organizadores sin canal propio que solo aparecen en la publicación de un tercero.
// Se crean como negocio con estado 'lead' (negocioId normal, así el alta no cambia). Identidad = nombre normalizado + provincia.
import { hash, fail, authorize, httpsUrl } from './event-domain.mjs';

const FORMAS = /\b(asociacion|asoc|aavv|a\s?v\s?v|club|agrupacion|federacion|fundacion|cooperativa|sociedad|peña|pena|hermandad|cofradia|colectivo|plataforma|ampa|ong|vecinal|vecinos)\b/g;
export const claveOrganizador = nombre => String(nombre || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9ñ]+/g, ' ').replace(FORMAS, ' ').replace(/\b(de|del|la|las|el|los|y|e)\b/g, ' ').replace(/\s+/g, ' ').trim();
export const claveProvincia = p => String(p || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function crearLead(store, input, principal) {
  authorize(principal, null, 'create_business');
  if (!principal.businesses.includes('*')) fail('business_forbidden');
  const clave = claveOrganizador(input.nombre), prov = claveProvincia(input.provincia);
  if (clave.length < 3) fail('lead_nombre_invalido');
  if (!prov) fail('lead_provincia_requerida');
  const t = input.fuenteTercero || fail('source_required');
  const url = httpsUrl(t.url);
  const key = 'biz_' + hash(['lead', clave, prov].join('\0')).slice(0, 32);
  const prior = await store.get('negocios', key);
  if (prior) return { negocioId: key, created: false, alreadyCreated: true, lead: true };
  const now = new Date().toISOString();
  const data = {
    uid: key, nombre: input.nombre.trim(), name: input.nombre.trim(), ciudad: input.ciudad || null, provincia: input.provincia.trim(), email: '',
    estado: 'lead', canalPropio: false, visible: false, origenRegistro: 'mcp_lead', organizadorClave: `${clave}|${prov}`,
    fuentesInformacion: {}, fuentesTercero: [{ url, nota: t.nota || null, registradaEn: now }],
    fechaCreacion: now, fechaActualizacion: now, createdBy: principal.id, creationFingerprint: hash(['lead', clave, prov].join('\0'))
  };
  try { await store.write('negocios', key, data, { create: true }); }
  catch (e) { if (e.code !== 'version_conflict') throw e; }
  return { negocioId: key, created: true, lead: true, cuentaFirebaseAuth: false };
}

export async function listarLeads(store, { provincia, minEventos = 3, limit = 100 }, principal) {
  authorize(principal, null, 'read');
  const rows = await store.list('negocios', { estado: 'lead', limit: Math.min(limit, 200) });
  const pv = provincia ? claveProvincia(provincia) : null, out = [];
  for (const r of rows) {
    if (!(principal.businesses.includes('*') || principal.businesses.includes(r.id))) continue;
    if (pv && claveProvincia(r.data.provincia) !== pv) continue;
    const evs = (await store.list('eventos', { business: r.id, limit: 100 })).filter(e => e.data.retirado !== true);
    if (evs.length < minEventos) continue;
    out.push({ negocioId: r.id, nombre: r.data.nombre, provincia: r.data.provincia, ciudad: r.data.ciudad ?? null, eventos: evs.length, municipios: [...new Set(evs.map(e => e.data.city).filter(Boolean))], fuentes: (r.data.fuentesTercero || []).map(f => f.url), creadoEn: r.data.fechaCreacion });
  }
  return { leads: out.sort((a, b) => b.eventos - a.eventos), minEventos };
}
