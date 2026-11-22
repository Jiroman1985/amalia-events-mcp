// identidad.mjs — identidad única por agente. Cada token (principal) se resuelve a UN agente canónico; el principal original se guarda aparte para auditoría.
// El mapa vive aquí (y en el dashboard): alias → canónico. Los principales no listados son su propio agente (p. ej. claude-ingesta).
export const AGENTES = ['alfred', 'alfie', 'conchi', 'amalia', 'hark', 'lola', 'susan', 'rene'];
export const ALIAS = {
  'alfred-altas': 'alfred', 'alfred-ediciones': 'alfred',
  'amalia-asistente': 'amalia',
  'conchi-owner': 'conchi',            // principal del token de administración del MCP (MCP_TOKEN)
  'lola-operator': 'lola',             // preparada: Lola
  'susan': 'susan'                     // preparada: Susan (sin acceso al panel ni al tablón por ahora)
};
export const agenteCanonico = id => { const k = String(id ?? '').toLowerCase().trim(); return ALIAS[k] || k; };
export const esAgente = id => AGENTES.includes(agenteCanonico(id));
/** Identidad de un principal autenticado: {agente (canónico), principal (original)}. */
export const identidadDe = p => ({ agente: p?.agente || agenteCanonico(p?.id), principal: p?.id ?? null });
/** Decora un principal del registro de acceso con su agente canónico SIN cambiar su id (los recibos y la idempotencia siguen ligados al token original). */
// Permisos que se derivan del AGENTE (no del token): valen con cualquiera de sus tokens. Se SUMAN a lo que diga el registro de acceso.
//  - alfred decide: edita y retira (y recupera) en cualquier negocio y administra el tablón.
//  - conchi retira (y recupera) para limpiar duplicados.
// Nunca hay borrado físico: retirar es reversible (recuperar_evento) y queda registrado quién y cuándo.
export const PERMISOS_AGENTE = {
  alfred: { acciones: ['read', 'edit', 'complete', 'retire', 'restore', 'board', 'board_admin'], todosLosNegocios: true },
  conchi: { acciones: ['retire', 'restore'], todosLosNegocios: false }
};
export const conIdentidad = p => {
  if (!p) return p;
  const agente = agenteCanonico(p.id), extra = PERMISOS_AGENTE[agente];
  const out = { ...p, agente, principalOriginal: p.id };
  if (extra && !(p.actions || []).includes('*')) out.actions = [...new Set([...(p.actions || []), ...extra.acciones])];
  if (extra?.todosLosNegocios && !(p.businesses || []).includes('*') && (p.actions || []).length) out.businesses = ['*'];
  return out;
};
