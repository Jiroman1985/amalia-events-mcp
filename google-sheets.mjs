// google-sheets.mjs — acceso mínimo a Google Sheets con la cuenta de servicio (sin dependencias). La hoja debe estar compartida con su correo.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const b64 = v => Buffer.from(v).toString('base64url');
export async function accessToken(credentialsFile, scope = 'https://www.googleapis.com/auth/spreadsheets.readonly', fetchImpl = fetch) {
  const c = JSON.parse(readFileSync(credentialsFile, 'utf8')), t = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), body = b64(JSON.stringify({ iss: c.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3000 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(c.private_key, 'base64url');
  const r = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  const j = await r.json(); if (!j.access_token) throw new Error('token_error:' + (j.error || r.status)); return j.access_token;
}
export const correoCuenta = file => JSON.parse(readFileSync(file, 'utf8')).client_email;
export async function leerPestana({ hojaId, pestana, credentialsFile, fetchImpl = fetch }) {
  const token = await accessToken(credentialsFile, 'https://www.googleapis.com/auth/spreadsheets.readonly', fetchImpl);
  const r = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${hojaId}/values/${encodeURIComponent(pestana)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`, { headers: { authorization: 'Bearer ' + token } });
  const j = await r.json(); if (!r.ok) { const e = new Error('sheets_' + r.status + ':' + (j.error?.status || '')); e.status = r.status; e.detalle = j.error?.message; throw e; }
  return j.values || [];
}
/** Sustituye el contenido de una pestaña (exportación de solo lectura). Exige permiso de editor para la cuenta de servicio. */
export async function escribirPestana({ hojaId, pestana, filas, credentialsFile, fetchImpl = fetch }) {
  const token = await accessToken(credentialsFile, 'https://www.googleapis.com/auth/spreadsheets', fetchImpl), h = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const rango = encodeURIComponent(pestana);
  let r = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${hojaId}/values/${rango}:clear`, { method: 'POST', headers: h, body: '{}' });
  if (!r.ok) throw new Error('sheets_clear_' + r.status);
  r = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${hojaId}/values/${rango}?valueInputOption=RAW`, { method: 'PUT', headers: h, body: JSON.stringify({ range: pestana, majorDimension: 'ROWS', values: filas }) });
  if (!r.ok) throw new Error('sheets_write_' + r.status);
  return filas.length;
}
