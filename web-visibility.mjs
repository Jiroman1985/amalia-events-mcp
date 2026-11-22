/** Read-only check of the public AMALIA map API; never infers why a plan is absent. */
export async function checkMapVisibility(eventId, fetchImpl=fetch) {
 const url=new URL('https://amalia-experience.com/api/eventos-mapa');
 url.searchParams.set('plan',eventId);
 const checkedAt=new Date().toISOString();
 try {
  const r=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{accept:'application/json'}});
  const cache=r.headers?.get?.('cache-control')||null;
  if(![200,404].includes(r.status))return {estado:'inconcluyente',status:r.status,consultadoEn:checkedAt,ayuda:'La API no confirmó la visibilidad; inténtalo más tarde sin volver a insertar el evento.'};
  const contentType=r.headers?.get?.('content-type')||'';
  if(!contentType.toLowerCase().includes('application/json'))return {estado:'inconcluyente',status:r.status,consultadoEn:checkedAt,ayuda:'La API no devolvió una respuesta verificable.'};
  const data=await r.json();
  if(r.status===200&&data?.evento?.id===eventId)return {estado:'visible_en_mapa',status:r.status,consultadoEn:checkedAt,cache,nota:'La API pública devuelve este plan. Esto no verifica la representación visual ni todos los buscadores.'};
  if(r.status===404&&data?.error==='plan_no_disponible')return {estado:'no_disponible_en_mapa',status:r.status,consultadoEn:checkedAt,cache,ayuda:'El mapa aún no devuelve el plan. Puede ser caché o un filtro de fecha, ubicación o visibilidad; no lo vuelvas a insertar.'};
  return {estado:'inconcluyente',status:r.status,consultadoEn:checkedAt,ayuda:'La respuesta no identifica el plan solicitado; no vuelvas a insertarlo.'};
 } catch {return {estado:'inconcluyente',consultadoEn:checkedAt,ayuda:'No se pudo consultar la API pública; conserva el evento y vuelve a comprobar más tarde.'};}
}
