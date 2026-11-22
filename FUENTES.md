# Repositorio único de fuentes (Firestore `registro_fuentes`, puerta única: el MCP)

## Modelo (campos del documento; `region` = CCAA, `eventos_aportados` = eventos encontrados)
id estable (doc id `fte_…`; el código `F-XXX-0000` de la hoja va en `codigo`, único) · nombre_entidad · tipo (ayuntamiento, bando, agenda, teatro, asociacion, negocio, redes, diputacion, medio, plataforma, turismo, otro) · ambito (municipio, comarca, provincia, region/ccaa, nacional) · region (CCAA) · provincia · comarca · municipio · zona · url · url_normalizada · redes {instagram, facebook, x, tiktok} · email · telefono · frecuencia_dias (7 por defecto) · ultima_revision · proxima_revision (= última + frecuencia) · responsable (agente) · estado (descubierta*, activa, pausada, bloqueada, descartada; fusionada la fija el sistema) · motivo_bloqueo {texto, licenciaUrl} · eventos_aportados · ultimo_evento_encontrado · origen · notas · creada_por/creada_en · modificada_por/modificada_en · historial (últimos 25 cambios con agente y motivo).
(*) descubierta = recién registrada, sin validar; cuenta como activa para las revisiones.

## Herramientas
registrar_fuente · actualizar_fuente · marcar_revisada · listar_fuentes_vencidas · buscar_fuente · resumen_fuentes. El agente sale siempre del token (creada_por, modificada_por, revisadaPor).

## Instrucciones para los agentes (Conchi, AMALia, Alfie, Hark, Alfred, Susan)
1. Dejar de escribir en la hoja «Fuentes actuales amalia»: pasa a ser una exportación de solo lectura.
2. Antes de añadir una fuente: `buscar_fuente` (url, nombre o municipio). Si ya existe, usar su ID; no registrar otra vez.
3. Fuente nueva: `registrar_fuente` (con `via`). Si devuelve `rechazada=true`, usar el `fuenteId` devuelto. Si devuelve `avisos` de posible_duplicado, revisar y, si es la misma entidad, avisar a Alfred (fusiona con `actualizar_fuente fusionarDesde`); nunca se borra nada.
4. Al revisar una fuente: `marcar_revisada` con `eventosNuevos` (0 si nada). Para saber qué toca: `listar_fuentes_vencidas` (responsable "yo" o zona).
5. Fuente bloqueada o pausada: `actualizar_fuente estado=bloqueada` con `motivoBloqueo {texto, licenciaUrl}`.
6. En cada alta de evento pasar `fuenteId` (el de la fuente de donde sale). Sin él, el rendimiento se infiere por URL, pero es menos fiable.
7. Enlaces share.google/acortados: abrirlos y registrar la URL final.

## Consultas para la vista del dashboard (lectura de `registro_fuentes`, excluir `estado == 'fusionada'`)
- Por zona: agrupar por `zona || region || provincia` (función `porZona`, `resumen_fuentes.porZona`).
- Por responsable: agrupar por `responsable` (`porResponsable`).
- Vencidas: `estado in (descubierta, activa)` y (`ultima_revision == null` o `proxima_revision <= ahora`); orden por `ultima_revision` ascendente (`listar_fuentes_vencidas`). En Firestore: `where('estado','in',[...]).where('proxima_revision','<=',ahoraISO).orderBy('proxima_revision')` (+ índice compuesto estado+proxima_revision) y aparte `where('ultima_revision','==',null)`.
- Rendimiento: eventos por fuente = eventos con `fuenteId == id|codigo` (directos) + los que coinciden por URL de la primera fuente (inferidos) (`rendimiento`, `resumen_fuentes conRendimiento=true`). En Firestore: `eventos.where('fuenteId','==',id)` (índice simple).
- Bloqueadas: `where('estado','==','bloqueada')` con `motivo_bloqueo`.

## Scripts (solo lectura salvo `--aplicar`)
- `node migrar_fuentes.mjs --csv fuentes.csv --salida informe.json` (ENSAYO, no escribe). `--hoja-id <id> --pestana Fuentes` lee la hoja directamente si está compartida con la cuenta de servicio. Aplicar: `--aplicar --confirmo <huella del informe aprobado>`.
- `node exportar_fuentes_sheet.mjs --salida fuentes.csv` / `--hoja-id <id> --pestana Fuentes --escribir` (cron diario tras migrar; la cuenta de servicio debe ser editora).
