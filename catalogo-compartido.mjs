// GENERADO desde amalia-vibrant-journeys/netlify/functions-v2/lib/catalogo (huella de la fuente: 1c0c41a974eed068). No editar a mano: node scripts/catalogo-mcp.mjs <salida>

// netlify/functions-v2/lib/catalogo/categorias.ts
var CATEGORIAS = [
  { id: "eventos_de_temporada", nombre: "Eventos de temporada", icono: "\u{1F38A}" },
  { id: "entretenimiento_y_cultura", nombre: "Entretenimiento y cultura", icono: "\u{1F3AD}" },
  { id: "experiencias_gastronomicas", nombre: "Experiencias gastron\xF3micas", icono: "\u{1F37D}\uFE0F" },
  { id: "planes_con_ninos_o_en_familia", nombre: "Planes con ni\xF1os o en familia", icono: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}" },
  { id: "aventura_deporte_y_naturaleza", nombre: "Aventura, deporte y naturaleza", icono: "\u{1F9D7}\u200D\u2642\uFE0F" },
  { id: "bienestar_y_desarrollo_personal", nombre: "Bienestar y desarrollo personal", icono: "\u{1F9D8}\u200D\u2640\uFE0F" },
  { id: "arte_y_creatividad", nombre: "Arte y creatividad", icono: "\u{1F3A8}" },
  { id: "business", nombre: "Business", icono: "\u{1F4BC}" }
];
var T = "eventos_de_temporada";
var E = "entretenimiento_y_cultura";
var G = "experiencias_gastronomicas";
var F = "planes_con_ninos_o_en_familia";
var A = "aventura_deporte_y_naturaleza";
var B = "bienestar_y_desarrollo_personal";
var R = "arte_y_creatividad";
var N = "business";
var esCategoriaId = (v) => CATEGORIAS.some((c) => c.id === v);
var nombreDeCategoria = (id) => CATEGORIAS.find((c) => c.id === id)?.nombre ?? null;
function claveCategoria(raw) {
  return raw.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/^\s*\d+\s*[.)-]\s*/, "").replace(/[.:–—]+/g, " ").replace(/[_\-·/,;|]+/g, " ").replace(/\s+/g, " ").trim();
}
var DIRECTAS = {};
var alta = (id, ...claves) => claves.forEach((k) => DIRECTAS[k] = { id, confianza: "alta" });
var media = (id, ...claves) => claves.forEach((k) => DIRECTAS[k] = { id, confianza: "media" });
alta(T, "eventos de temporada", "eventos temporada", "temporada", "estacional", "navidad", "semana santa", "halloween");
alta(
  E,
  "entretenimiento y cultura",
  "entretenimiento",
  "cultura",
  "musica",
  "musica jazz",
  "musica y festivales",
  "teatro",
  "conciertos",
  "concierto",
  "espectaculo",
  "flamenco",
  "danza",
  "danza cultura",
  "cultura tradicional",
  "museo",
  "exposicion"
);
alta(G, "experiencias gastronomicas", "gastronomia", "gastronomia proximidad", "restaurantes", "restaurante", "comida", "gastro");
alta(
  F,
  "planes con ninos o en familia",
  "planes con ninos o familia",
  "planes familiares y con ninos",
  "familia",
  "familiar",
  "infantil",
  "ninos",
  "actividades familiares",
  "actividades para ninos"
);
alta(
  A,
  "aventura deporte y naturaleza",
  "aventura y naturaleza",
  "aventura deporte",
  "aventura",
  "deporte",
  "deportes",
  "naturaleza",
  "senderismo",
  "actividades al aire libre",
  "deportes y aventura"
);
alta(B, "bienestar y desarrollo personal", "bienestar", "spa", "wellness", "relajacion", "desarrollo personal", "yoga");
alta(R, "arte y creatividad", "arte", "creatividad", "pintura", "fotografia", "talleres artisticos");
alta(
  N,
  "business",
  "negocios",
  "negocios y networking",
  "networking",
  "emprendimiento",
  "empresarial",
  "profesional",
  "startup",
  "startups",
  "corporativo"
);
alta(E, "eventos culturales", "arte y cultura", "ocio y cultura", "exposiciones", "cine", "cine y teatro");
alta(G, "experiencia gastronomica", "gastronomia");
alta(A, "eventos y actividades deportivas", "naturaleza senderismo aventura", "naturaleza y senderismo", "actividades deportivas");
alta(F, "ocio familiar");
alta(B, "bienestar spas balnearios");
media(G, "establecimiento de hosteleria", "hosteleria");
media(E, "patrimonio", "ocio nocturno");
media(B, "salud");
media(R, "taller", "taller artesania", "danza taller");
media(F, "teatro familiar");
media(E, "festival");
var AMBIGUAS = {
  ocio: [E, G, A, B, F],
  leisure: [E, G, A, B, F],
  evento: [],
  eventos: [],
  turismo: [E, A],
  fiesta: [T, E],
  "fiestas locales": [T, E],
  fiestas: [T, E],
  "fiestas patronales tradicion": [T, E],
  mercado: [G, T, R],
  mercadillo: [G, T, R],
  "mercado ecologico y artesano": [G, R],
  "mercadillo navideno artesania rural": [T, R],
  "feria agroganadera mercado navideno tradicion rural": [T, G],
  "fiesta gastronomica tradicion rural": [G, T],
  "naturaleza micoturismo gastronomia": [A, G],
  "naturaleza gastronomia": [A, G],
  parque: [F, A],
  // Ni categorías ni equivalentes de evento: ruido del perfilador o tipos de negocio (alojamiento, transporte). Se listan para que no
  // parezcan «no reconocidos» por descuido, y nunca se asignan.
  actividades: [],
  experiencia: [],
  general: [],
  otros: [],
  "parques y atracciones": [F, A]
};
var TEXTO = [
  { id: B, re: /\b(yoga|meditaci\w*|mindfulness|spa|masajes?|body sculpt|sound healing|breathwork|tratamiento (corporal|facial)|retiro)\b/, fuerte: true },
  { id: N, re: /\b(networking|emprendedor\w*|startups?|coworking|b2b|jornada empresarial|conferencia de negocios)\b/, fuerte: true },
  { id: A, re: /\b(senderismo|kayak|escalada|parapente|paintball|rafting|surf|buceo|quad|via ferrata|trekking|esqui|karting|airsoft|tirolina|barranquismo|snorkel|globo aerostatico|a caballo|equitacion)\b/, fuerte: true },
  { id: G, re: /\b(cata|catas|degustaci\w*|maridaje|brunch|tapeo|ruta gastronomica|menu degustacion|showcooking|cocina en vivo)\b/, fuerte: true },
  { id: F, re: /\b(en familia|para ninos|para ninas|infantil|peques|kids)\b/, fuerte: true },
  { id: R, re: /\b(taller de (pintura|ceramica|dibujo|escultura|fotografia|caligrafia)|ceramica|escultura|acuarela|manualidades)\b/, fuerte: true },
  { id: T, re: /\b(navidad|navidenos?|reyes magos|halloween|semana santa|carnaval|nochevieja|san valentin|black friday)\b/, fuerte: false },
  { id: E, re: /\b(concierto|teatro|musical|monologo|comedia|exposici\w*|museo|cine|opera|espectaculo|stand up|circo|magia)\b/, fuerte: false }
];
var sinAcentos = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
function categoriaOriginal(doc) {
  for (const v of [doc.categoria, doc.category]) if (typeof v === "string" && v.trim()) return v.trim();
  const lista = Array.isArray(doc.categorias) ? doc.categorias.find((v) => typeof v === "string" && v.trim()) : null;
  return lista ? String(lista).trim() : null;
}
function desdeFuente(original) {
  const clave = claveCategoria(original);
  if (!clave) return null;
  if (DIRECTAS[clave]) return DIRECTAS[clave];
  if (clave in AMBIGUAS) return { ambiguas: AMBIGUAS[clave] };
  const partes = original.split(/[·/;|]+/).map(claveCategoria).filter(Boolean);
  if (partes.length > 1) {
    const ids = new Set(partes.map((p) => DIRECTAS[p]?.id).filter(Boolean));
    if (ids.size === 1 && partes.every((p) => DIRECTAS[p])) return { id: [...ids][0], confianza: "media" };
    if (ids.size > 1) return { ambiguas: [...ids] };
  }
  return null;
}
function senalesTexto(doc) {
  const limpio = (v) => typeof v === "string" ? sinAcentos(v) : "";
  const titulo = [doc.nombre, doc.title, doc.titulo].map(limpio).join(" ");
  const cuerpo = [doc.descripcion, doc.description].map(limpio).join(" ");
  const cuenta = (re, t) => t.match(new RegExp(re.source, "g"))?.length ?? 0;
  return TEXTO.map((t) => ({ id: t.id, fuerte: t.fuerte, enTitulo: t.re.test(titulo), aciertos: cuenta(t.re, titulo) + cuenta(t.re, cuerpo) })).filter((t) => t.aciertos > 0);
}
var concluyente = (s) => s.fuerte && (s.enTitulo || s.aciertos >= 2);
function clasificarCategoria(doc) {
  const original = categoriaOriginal(doc);
  const senales = senalesTexto(doc);
  const fuente = original ? desdeFuente(original) : null;
  if (fuente && "ambiguas" in fuente) {
    const enTitulo = [...new Set(senales.filter((s) => s.enTitulo).map((s) => s.id))];
    const posibles = fuente.ambiguas.length ? enTitulo.filter((id) => fuente.ambiguas.includes(id)) : enTitulo;
    if (enTitulo.length === 1 && posibles.length === 1) {
      return { id: posibles[0], estado: "asignada", confianza: "media", origen: "fuente+texto", original, alternativas: fuente.ambiguas.filter((id) => id !== posibles[0]), motivo: "ambiguo_resuelto_por_el_titulo" };
    }
    return { id: null, estado: "revision", confianza: "baja", origen: "fuente", original, alternativas: fuente.ambiguas, motivo: "valor_original_ambiguo" };
  }
  if (fuente) {
    const contradicen = senales.filter((s) => concluyente(s) && s.id !== fuente.id).map((s) => s.id);
    if (fuente.id === E && contradicen.length > 0) {
      return { id: null, estado: "revision", confianza: "baja", origen: "fuente+texto", original, alternativas: [E, ...new Set(contradicen)], motivo: "fuente_generica_contradicha_por_texto" };
    }
    const extra = senales.filter((s) => s.id !== fuente.id).map((s) => s.id);
    return {
      id: fuente.id,
      estado: "asignada",
      confianza: fuente.confianza,
      origen: senales.some((s) => s.id === fuente.id) ? "fuente+texto" : "fuente",
      original,
      alternativas: [...new Set(extra)],
      motivo: fuente.confianza === "alta" ? "valor_original_equivalente" : "valor_original_probable"
    };
  }
  const unicas = [...new Set(senales.map((s) => s.id))];
  if (unicas.length === 1) {
    return { id: unicas[0], estado: "asignada", confianza: "media", origen: "texto", original, alternativas: [], motivo: "inferida_del_texto" };
  }
  return {
    id: null,
    estado: "revision",
    confianza: "baja",
    origen: unicas.length ? "texto" : "ninguno",
    original,
    alternativas: unicas,
    motivo: original ? "valor_original_desconocido" : unicas.length ? "varias_categorias_en_el_texto" : "sin_categoria"
  };
}
function resolverValorCategoria(valor) {
  if (!valor || !valor.trim()) return { tipo: "desconocida" };
  if (esCategoriaId(valor)) return { tipo: "id", id: valor, confianza: "alta" };
  const r = desdeFuente(valor);
  if (!r) return { tipo: "desconocida" };
  return "ambiguas" in r ? { tipo: "ambigua", alternativas: r.ambiguas } : { tipo: "id", id: r.id, confianza: r.confianza };
}
function categoriaIdDesde(valor) {
  if (!valor) return void 0;
  if (esCategoriaId(valor)) return valor;
  const r = desdeFuente(valor);
  return r && "id" in r && r.confianza === "alta" ? r.id : void 0;
}
var VARIANTES = Object.fromEntries(
  CATEGORIAS.map((c) => [c.id, Object.entries(DIRECTAS).filter(([, v]) => v.id === c.id).map(([k]) => k)])
);

// netlify/functions-v2/lib/catalogo/fechas.ts
var MESES = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
};
var DIAS_SEMANA = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
var DIAS_PERIODO = 14;
var sinAcentos2 = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
var pad = (n) => String(n).padStart(2, "0");
var iso = (a, m, d) => `${a}-${pad(m)}-${pad(d)}`;
function diaValido(a, m, d) {
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}
function sumarDias(dia, n) {
  const d = /* @__PURE__ */ new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
var diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
function enMadrid(isoZ) {
  const f = new Date(isoZ);
  if (Number.isNaN(f.getTime())) return null;
  return {
    dia: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(f),
    hora: new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(f)
  };
}
function horaDe(s) {
  const m = s.match(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
  return m ? `${pad(Number(m[1]))}:${m[2]}` : null;
}
function leerIso(v) {
  const dias = v.match(/\d{4}-\d{2}-\d{2}/g);
  if (!dias) return null;
  if (!dias.every((d) => diaValido(Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))))) return null;
  const conZona = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v.trim());
  const m = conZona ? enMadrid(v.trim()) : null;
  const inicio = m?.dia ?? dias[0];
  return { inicio, fin: dias[1] && dias[1] > inicio ? dias[1] : null, hora: m?.hora ?? horaDe(v.slice(10)) };
}
function leerTextoEs(v, referencia) {
  const t = sinAcentos2(v);
  const mes = "(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)";
  const hora = horaDe(t);
  const rango = t.match(new RegExp(`\\bdel?\\s+(?:[a-z]+\\s+)?(\\d{1,2})\\s+al\\s+(?:[a-z]+\\s+)?(\\d{1,2})\\s+de\\s+${mes}\\s+de\\s+(\\d{4})`));
  if (rango) {
    const [d1, d2, m, a] = [Number(rango[1]), Number(rango[2]), MESES[rango[3]], Number(rango[4])];
    if (diaValido(a, m, d1) && diaValido(a, m, d2) && d2 >= d1) return { inicio: iso(a, m, d1), fin: d2 > d1 ? iso(a, m, d2) : null, hora };
    return null;
  }
  const completa = t.match(new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?${mes}\\s+(?:de\\s+)?(\\d{4})\\b`));
  if (completa) {
    const [d, m, a] = [Number(completa[1]), MESES[completa[2]], Number(completa[3])];
    return diaValido(a, m, d) ? { inicio: iso(a, m, d), fin: null, hora } : null;
  }
  const sinAnio = t.match(new RegExp(`\\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\\s+(\\d{1,2})\\s+de\\s+${mes}\\b`));
  if (sinAnio) {
    const [dia, d, m] = [DIAS_SEMANA.indexOf(sinAnio[1]), Number(sinAnio[2]), MESES[sinAnio[3]]];
    const base = Number(referencia.slice(0, 4));
    const posibles = [base - 1, base, base + 1].filter((a) => diaValido(a, m, d) && new Date(Date.UTC(a, m - 1, d)).getUTCDay() === dia).sort((x, y) => Math.abs(diasEntre(referencia, iso(x, m, d))) - Math.abs(diasEntre(referencia, iso(y, m, d))));
    if (posibles.length) return { inicio: iso(posibles[0], m, d), fin: null, hora, aviso: "anio_deducido_por_dia_de_semana" };
    return { sinFecha: "dia_de_semana_no_coincide" };
  }
  if (/\b(todos los|cada|todas las)\b.*\b(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|dias|fines? de semana|semanas?)\b/.test(t) || /^\s*(lunes|martes|miercoles|jueves|viernes|sabado|domingo)s?\s*$/.test(t)) return { sinFecha: "recurrencia_sin_calendario" };
  if (/\b(por confirmar|a confirmar|proximamente|permanente|todo el ano|horario comercial|a convenir)\b/.test(t)) return { sinFecha: "sin_fecha_concreta" };
  if (new RegExp(`\\b\\d{1,2}\\s+(?:de\\s+)?${mes}\\b|\\bdel?\\s+\\d{1,2}\\s+al\\s+\\d{1,2}\\s+de\\s+${mes}`).test(t)) return { sinFecha: "dia_sin_anio" };
  if (/^\s*\d{4}\s*$/.test(t)) return { sinFecha: "solo_anio" };
  if (/\b(primavera|verano|otono|invierno|julio y agosto)\b/.test(t)) return { sinFecha: "solo_estacion" };
  return null;
}
var CAMPOS_INICIO = ["dateTime", "fecha_inicio", "fechaInicio", "fechaLocal", "fecha"];
var CAMPOS_FIN = ["fecha_fin", "fechaFin", "fechaFinLocal", "dateTimeEnd"];
function resolverFechas(doc, hoy) {
  const avisos = [];
  let lectura = null;
  let fuente = null;
  let motivoSin = "sin_fecha";
  for (const campo of CAMPOS_INICIO) {
    const v = doc[campo];
    if (typeof v !== "string" || !v.trim()) continue;
    if (/\d{4}-((\d{2}|MM)-(XX|\?\?|DD)|XX|\?\?)/i.test(v)) {
      avisos.push(`${campo}_incompleta`);
      motivoSin = "fecha_incompleta";
      continue;
    }
    const l = leerIso(v);
    if (l) {
      lectura = l;
      fuente = campo;
      break;
    }
    const referencia = typeof doc.capturado_en === "string" ? doc.capturado_en.slice(0, 10) : hoy;
    const t = leerTextoEs(v, /^\d{4}-\d{2}-\d{2}$/.test(referencia) ? referencia : hoy);
    if (t && "sinFecha" in t) {
      avisos.push(`${campo}_${t.sinFecha}`);
      motivoSin = t.sinFecha;
      continue;
    }
    if (t) {
      lectura = t;
      fuente = `${campo}:texto`;
      if (t.aviso) avisos.push(t.aviso);
      break;
    }
  }
  if (!lectura) return { inicio: null, fin: null, hora: null, tipo: "sin_fecha", fuente: null, avisos, motivo: motivoSin };
  let fin = lectura.fin;
  for (const campo of CAMPOS_FIN) {
    const v = doc[campo];
    const l = typeof v === "string" ? leerIso(v) : null;
    if (l && l.inicio > lectura.inicio && (!fin || l.inicio > fin)) fin = l.inicio;
  }
  const horaCampo = [doc.hora, doc.horaLocal].map((v) => typeof v === "string" ? horaDe(v) : null).find(Boolean) ?? null;
  const hora = horaCampo ?? lectura.hora;
  const sinMedianoche = hora && hora !== "00:00" ? hora : null;
  const inicio = lectura.inicio;
  const duracion = fin ? diasEntre(inicio, fin) : 0;
  const tipo = !fin ? "dia" : duracion > DIAS_PERIODO ? "periodo" : "varios_dias";
  return { inicio, fin: fin ?? inicio, hora: sinMedianoche, tipo, fuente, avisos, motivo: tipo === "periodo" ? "ventana_de_disponibilidad" : "fecha_reconocida" };
}

// netlify/functions-v2/lib/catalogo/ubicacion.ts
var UMBRAL_REPETIDO = 5;
var KM_COINCIDE = 0.3;
var KM_DISCREPA = 1;
var KM_LEJOS_DEL_MUNICIPIO = 40;
function validarPar(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return { ok: false, motivo: "no_numerico" };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, motivo: "no_finito" };
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false, motivo: "fuera_de_rango" };
  if (lat === 0 && lng === 0) return { ok: false, motivo: "par_0_0" };
  return { ok: true, par: { lat, lng } };
}
var num = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
};
function leerPar(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const m = v.match(/^\s*(-?\d{1,3}(?:[.,]\d+)?)\s*[,;]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/);
    return m ? validarPar(Number(m[1].replace(",", ".")), Number(m[2].replace(",", "."))) : null;
  }
  if (typeof v !== "object") return null;
  const o = v;
  const lat = o.latitude ?? o._latitude ?? o.lat;
  const lng = o.longitude ?? o._longitude ?? o.lng ?? o.lon;
  if (lat === void 0 && lng === void 0) return null;
  return validarPar(num(lat), num(lng));
}
function distanciaKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
var claveRepetido = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
function contarRepetidos(docs) {
  const cuenta = /* @__PURE__ */ new Map();
  for (const d of docs) {
    for (const v of [leerPar({ lat: d.lat, lng: d.lng }), leerPar(d.ubicacion)]) {
      if (v?.ok) cuenta.set(claveRepetido(v.par), (cuenta.get(claveRepetido(v.par)) ?? 0) + 1);
    }
  }
  return cuenta;
}
var enEspana = (p) => p.lat >= 27 && p.lat <= 44.5 && p.lng >= -19 && p.lng <= 5.5;
var texto = (v) => typeof v === "string" ? v.trim() : "";
function resolverUbicacion(doc, ctx) {
  const avisos = [];
  const repetido = (p) => (ctx.repetidos?.get(claveRepetido(p)) ?? 0) >= UMBRAL_REPETIDO;
  const lugarTexto = texto(doc.place) || texto(doc.lugar) || (typeof doc.ubicacion === "string" && !leerPar(doc.ubicacion) ? texto(doc.ubicacion) : "");
  const cands = [];
  const anotar = (campo, r) => {
    if (r && !r.ok) avisos.push(`${campo}_descartado_${r.motivo}`);
    return r && r.ok ? r.par : null;
  };
  const geo = anotar("geo", leerPar(doc.geo));
  if (geo) {
    const fuenteGeo = texto(doc.geo_fuente) || "geo";
    cands.push({ par: geo, fuente: fuenteGeo, nivel: doc.geo_precision === "lugar" ? "lugar" : "ciudad", rango: doc.geo_precision === "lugar" ? 0 : 9 });
  }
  const tieneLatLng = doc.lat !== void 0 && doc.lat !== null;
  const latlng = tieneLatLng ? anotar("lat_lng", leerPar({ lat: doc.lat, lng: doc.lng })) : null;
  if (latlng) {
    cands.push({ par: latlng, fuente: texto(doc.source) ? `proveedor:${texto(doc.source)}` : "documento", nivel: repetido(latlng) ? "ciudad" : "sin_nivel", rango: repetido(latlng) ? 9 : 3 });
  }
  const declarada = anotar("ubicacion", leerPar(doc.ubicacion));
  if (declarada) {
    cands.push({ par: declarada, fuente: "declarada", nivel: repetido(declarada) ? "ciudad" : lugarTexto ? "lugar" : "sin_nivel", rango: repetido(declarada) ? 9 : lugarTexto ? 1 : 4 });
  }
  const coordenadas = anotar("coordenadas", leerPar(doc.coordenadas));
  if (coordenadas) cands.push({ par: coordenadas, fuente: "evento", nivel: lugarTexto ? "lugar" : "sin_nivel", rango: lugarTexto ? 2 : 5 });
  const base = { comprobadoEn: ctx.ahora };
  if (cands.length === 0) {
    return { ...base, lat: null, lng: null, tipo: "pendiente", verificacion: "sin_datos", fuentes: [], avisos, motivo: avisos.length ? "solo_coordenadas_invalidas" : "sin_coordenadas" };
  }
  const especificos = cands.filter((c) => c.nivel !== "ciudad").sort((a, b) => a.rango - b.rango);
  const ciudades = cands.filter((c) => c.nivel === "ciudad").sort((a, b) => a.rango - b.rango);
  if (especificos.length === 0) {
    const c = ciudades[0];
    if (!enEspana(c.par)) avisos.push("fuera_de_espana");
    return { ...base, lat: c.par.lat, lng: c.par.lng, tipo: "municipio", verificacion: "una_fuente", fuentes: [c.fuente], avisos, motivo: "solo_centro_de_municipio" };
  }
  const primario = especificos[0];
  const otros = especificos.slice(1);
  const fuentes = [primario.fuente];
  const distancias = otros.map((o) => ({ o, d: distanciaKm(primario.par, o.par) }));
  const lejanos = distancias.filter((x) => x.d > KM_DISCREPA);
  if (lejanos.length) {
    avisos.push(`fuentes_discrepantes_${Math.round(Math.min(...lejanos.map((x) => x.d)))}km`);
    return { ...base, lat: null, lng: null, tipo: "pendiente", verificacion: "discrepante", fuentes: [primario.fuente, ...lejanos.map((x) => x.o.fuente)], avisos, motivo: "fuentes_no_coinciden" };
  }
  const coinciden = distancias.filter((x) => x.d <= KM_COINCIDE);
  coinciden.forEach((x) => fuentes.push(x.o.fuente));
  if (distancias.some((x) => x.d > KM_COINCIDE)) avisos.push("fuentes_difieren_entre_300m_y_1km");
  const municipio = ciudades[0];
  if (municipio && distanciaKm(primario.par, municipio.par) > KM_LEJOS_DEL_MUNICIPIO) avisos.push("lejos_del_municipio_declarado");
  if (!enEspana(primario.par)) avisos.push("fuera_de_espana");
  const coherente = coinciden.length > 0;
  const esRecinto = primario.nivel === "lugar";
  return {
    ...base,
    lat: primario.par.lat,
    lng: primario.par.lng,
    tipo: esRecinto ? "recinto" : "direccion_aproximada",
    verificacion: coherente ? "coherente" : "una_fuente",
    fuentes: [...new Set(fuentes)],
    avisos,
    motivo: esRecinto ? coherente ? "recinto_campos_coincidentes" : "recinto_un_solo_campo" : coherente ? "punto_campos_coincidentes" : "punto_unico_sin_recinto"
  };
}
var tienePin = (u) => u.tipo !== "pendiente" && u.lat !== null && u.lng !== null;

// netlify/functions-v2/lib/catalogo/index.ts
var VERSION_CATALOGO = 1;
var REGLAS_CATALOGO = 3;
var CAMPO_CATALOGO = "catalogo_amalia_v1";
var CAMPO_REVISION = "catalogo_revision";
var ESTADOS_OCULTOS = /rechaz|reject|pend|cancel|borr|draft|oculto|hidden|retirad/i;
function visibilidadDe(doc) {
  if (doc.retirado === true) return { publicable: false, motivo: "retirado" };
  if (doc.activa === false) return { publicable: false, motivo: "inactivo" };
  if (doc.prueba === true) return { publicable: false, motivo: "prueba" };
  if (typeof doc.estado === "string" && ESTADOS_OCULTOS.test(doc.estado)) return { publicable: false, motivo: `estado_${doc.estado}` };
  if (doc.isPermanent === true) return { publicable: false, motivo: "permanente" };
  if (doc.source === "perplexity") return { publicable: false, motivo: "negocio_fijo" };
  return { publicable: true, motivo: "ok" };
}
var CAMPOS_ENTRADA = [
  "nombre",
  "title",
  "titulo",
  "descripcion",
  "description",
  "categoria",
  "category",
  "categorias",
  "lat",
  "lng",
  "geo",
  "geo_precision",
  "geo_fuente",
  "ubicacion",
  "coordenadas",
  "place",
  "lugar",
  "dateTime",
  "fecha_inicio",
  "fechaInicio",
  "fechaLocal",
  "fecha",
  "fecha_fin",
  "fechaFin",
  "fechaFinLocal",
  "dateTimeEnd",
  "hora",
  "horaLocal",
  "source",
  "estado",
  "activa",
  "retirado",
  "prueba",
  "isPermanent",
  CAMPO_REVISION
];
var canonico = (v) => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if ("latitude" in v || "_latitude" in v) {
      const par = leerPar(v);
      if (par?.ok) return { lat: par.par.lat, lng: par.par.lng };
    }
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonico(v[k])]));
  }
  return Array.isArray(v) ? v.map(canonico) : v;
};
function fnv(texto2) {
  let h1 = 3735928559 ^ 0, h2 = 1103547991 ^ 0;
  for (let i = 0; i < texto2.length; i++) {
    const c = texto2.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
function hashEntrada(doc) {
  const entrada = {};
  for (const k of CAMPOS_ENTRADA) if (doc[k] !== void 0 && doc[k] !== null) entrada[k] = canonico(doc[k]);
  return fnv(JSON.stringify({ reglas: REGLAS_CATALOGO, ...entrada }));
}
function aplicarRevision(doc, cat, ubi) {
  const rev = doc[CAMPO_REVISION];
  const por = typeof rev?.por === "string" ? rev.por : "revision_manual";
  let categoria = cat;
  let ubicacion = ubi;
  if (rev && esCategoriaId(rev.categoria)) {
    categoria = { id: rev.categoria, estado: "asignada", confianza: "alta", origen: "fuente", original: cat.original, alternativas: [], motivo: "revision_manual", revisadaPor: por };
  }
  const u = rev?.ubicacion;
  const v = u ? validarPar(u.lat, u.lng) : null;
  if (v?.ok && ["recinto", "direccion_aproximada", "municipio"].includes(u.tipo)) {
    ubicacion = {
      lat: v.par.lat,
      lng: v.par.lng,
      tipo: u.tipo,
      verificacion: "verificada",
      fuentes: ["revision_manual", ...typeof u.fuente === "string" ? [u.fuente] : []],
      comprobadoEn: typeof u.comprobadoEn === "string" ? u.comprobadoEn : ubi.comprobadoEn,
      avisos: [],
      motivo: "revision_manual",
      revisadaPor: por
    };
  }
  return { categoria, ubicacion };
}
function calcularCatalogo(doc, ctx) {
  const { categoria, ubicacion } = aplicarRevision(doc, clasificarCategoria(doc), resolverUbicacion(doc, { repetidos: ctx.repetidos, ahora: ctx.ahora }));
  return {
    version: VERSION_CATALOGO,
    calculadoEn: ctx.ahora,
    entradaHash: hashEntrada(doc),
    categoria,
    ubicacion,
    fechas: resolverFechas(doc, ctx.hoy),
    visibilidad: visibilidadDe(doc)
  };
}
function catalogoVigente(doc, ctx) {
  const guardado = doc[CAMPO_CATALOGO];
  if (guardado?.version === VERSION_CATALOGO && guardado.entradaHash === hashEntrada(doc)) return { catalogo: guardado, origen: "guardado" };
  return { catalogo: calcularCatalogo(doc, ctx), origen: "calculado" };
}
var VENTANA_DIAS = 90;
var sumarDiasIso = (dia, n) => {
  const d = /* @__PURE__ */ new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
function estadoPublicacion(c, hoy) {
  if (!c.visibilidad.publicable) return { publicable: false, motivo: "no_publicable", detalle: c.visibilidad.motivo };
  const { fechas, ubicacion } = c;
  if (!fechas.inicio || !fechas.fin || fechas.tipo === "sin_fecha") return { publicable: false, motivo: "sin_fecha", detalle: fechas.motivo };
  if (fechas.fin < hoy) return { publicable: false, motivo: "pasado" };
  if (fechas.inicio > sumarDiasIso(hoy, VENTANA_DIAS)) return { publicable: false, motivo: "fuera_de_ventana" };
  if (!tienePin(ubicacion) || ubicacion.tipo === "pendiente") return { publicable: false, motivo: "sin_ubicacion_comprobable", detalle: ubicacion.motivo };
  return { publicable: true };
}
function pendientesDe(c, hoy) {
  if (!c.visibilidad.publicable) return [];
  const { fechas, ubicacion, categoria } = c;
  if (fechas.inicio && fechas.fin && fechas.fin < hoy) return [];
  const enVentana = !!fechas.inicio && fechas.inicio <= sumarDiasIso(hoy, VENTANA_DIAS);
  const out = [];
  if (fechas.tipo === "sin_fecha") out.push({ tipo: "fecha", motivo: fechas.motivo, detalle: fechas.avisos, enVentana: false });
  if (!tienePin(ubicacion)) out.push({ tipo: "ubicacion", motivo: ubicacion.verificacion === "discrepante" ? "fuentes_no_coinciden" : ubicacion.motivo, detalle: ubicacion.avisos, enVentana });
  if (categoria.estado === "revision") out.push({ tipo: "categoria", motivo: categoria.motivo, detalle: categoria.alternativas, enVentana });
  return out;
}
export {
  CAMPO_CATALOGO,
  CAMPO_REVISION,
  CATEGORIAS,
  REGLAS_CATALOGO,
  VARIANTES,
  VENTANA_DIAS,
  VERSION_CATALOGO,
  calcularCatalogo,
  catalogoVigente,
  categoriaIdDesde,
  categoriaOriginal,
  clasificarCategoria,
  claveCategoria,
  claveRepetido,
  contarRepetidos,
  distanciaKm,
  esCategoriaId,
  estadoPublicacion,
  hashEntrada,
  leerPar,
  nombreDeCategoria,
  pendientesDe,
  resolverFechas,
  resolverUbicacion,
  resolverValorCategoria,
  sumarDias,
  tienePin,
  validarPar,
  visibilidadDe
};
