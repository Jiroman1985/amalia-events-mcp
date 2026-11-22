import { createHmac, randomBytes } from 'node:crypto';
import { schedule, GeoPunto } from './event-domain.mjs';

export function makeDocumentId(requestId, token) {
  return requestId
    ? createHmac('sha256', token).update(`amalia-event:${requestId}`).digest('hex').slice(0, 28)
    : randomBytes(15).toString('hex');
}

export function buildEventRecord(input, scope, now = new Date()) {
  const title = input.titulo.trim();
  const description = input.descripcion.trim();
  const city = input.city.trim();
  const category = input.categoria?.trim();
  const link = input.link?.trim();
  const image = input.image?.trim();
  const place = input.lugar?.trim() || city;
  const stamp = now.toISOString();

  return Object.fromEntries(Object.entries({
    titulo: title,
    nombre: title,
    descripcion: description,
    description,
    ...schedule(input),
    city,
    ubicacion: city,
    lugar: place,
    town: city,
    place: city,
    negocioId: scope.businessId,
    uidNegocio: scope.businessId,
    marca: scope.brandId,
    marcaId: scope.brandId,
    categoria: category,
    category,
    precio: input.precio,
    image,
    imagen: image,
    link,
    enlace_original: link,
    'local-sustainable-tip': input.sustainableTip?.trim(),
    'public-transport': input.publicTransport?.trim(),
    aforo: input.aforo,
    impactos: 0,
    clics_compra_entradas: 0,
    visitas: 0,
    interacciones: 0,
    fecha: stamp,
    fechaCreacion: stamp,
    fechaActualizacion: stamp,
    metrics: { views: 0, clicks: 0, interactions: 0 }
  }).filter(([, value]) => value !== undefined));
}

function firestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof GeoPunto) return { geoPointValue: { latitude: value.latitude, longitude: value.longitude } };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, firestoreValue(nested)])) } };
}

export function toFirestoreFields(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, firestoreValue(value)]));
}
