# AMALIA Events MCP v2.4

Registro canónico: Firebase, colección eventos. La ingesta, Conchi y la consulta explícita de eventos guardados de Hermes utilizan este contrato. Los JSON de los cosechadores son staging. La búsqueda de Internet de WhatsApp conserva su propia herramienta.

## Eventos

buscar_negocio, crear_negocio, crear_evento, obtener_evento, listar_eventos, editar_evento, historial_evento, retirar_evento, recuperar_evento.

La creación directa (`crear_evento`, incluido el método de servicio) está cerrada. Para una ficha completa:

1. Llamar a `preparar_admision` con el evento. Es solo lectura: no guarda propuestas ni descarga imágenes. Las imágenes deben existir previamente como `assetId` si se van a adjuntar.
2. Comprobar `admisible=true`, `exhaustivo=true` y ausencia de coincidencias. Si hay conflicto, no se admite ni se fusiona automáticamente.
3. Llamar a `admitir_candidato` con `{accion:"admit", proposalHash, evento}` utilizando exactamente el hash y el objeto `evento` devueltos en el paso anterior. Requiere la acción `admit`; un permiso antiguo `create` no la sustituye.
4. El servidor vuelve a leer guardia, catálogo completo (páginas de hasta 500, máximo 5000 eventos) y todas las reservas, y vuelve a comprobar la propuesta. Guarda evento capturado, historial, idempotencia, reserva de origen cuando exista y guardia en un solo commit con precondición `updateTime`. Reintenta el protocolo entero hasta tres veces ante concurrencia.

El documento `amalia_catalog_guard/eventos` debe aprovisionarse expresamente durante el despliegue; los writers nunca lo crean. `admissionPaused=true` bloquea nuevas admisiones y cambios de identidad sin alterar la pausa editorial. Las reservas sobreviven a las purgas y siguen bloqueando la readmisión aunque el evento ya no exista. Los campos de identidad no se editan por `editar_evento`; las correcciones de descripción y la verificación explícita siguen separadas. Ninguna admisión crea eventos `verificado` ni cambia los estados de los históricos.

`buscar_duplicados_global` sigue disponible para exploración. El contenido incompleto va a `guardar_candidato` en la colección privada `candidatos_eventos`; esa colección no es el catálogo público. Las fechas, sesiones y precios conservan el contrato v1: no inventar hora, `periodo_venta` no es sesión y precio desconocido nunca es cero.

Negocio obligatorio. sesionId distingue sesiones aunque compartan URL. fechaLocal YYYY-MM-DD, timeZone y horaLocal opcional: una hora desconocida conserva null y «Sin hora definida». Una medianoche explícita sigue siendo 00:00. Una hora ambigua requiere dateTime con desplazamiento explícito.

expectedVersion evita sobrescribir revisiones recientes. Negocio y propietario son inmutables. requestId hace los reintentos idempotentes; datos distintos con la misma clave son un conflicto. Fuentes con URL y fecha de comprobación; contradicciones impiden verificar el evento.

## Recursos y revisión

guardar_imagen conserva bytes, huella, procedencia, crédito y declaración de derechos. Las imágenes se alojan en Firebase Storage y su manifiesto en Firestore. Una imagen pública no se considera reutilizable por defecto.

crear_borrador, editar_borrador, consultar_pieza, listar_piezas, historial_pieza y solicitar_revision_pieza separan hechos del evento y aprobación editorial. La página privada muestra texto, recurso, cuenta y fecha exactos. Cualquier cambio invalida la aprobación.

## Kalma es el publicador

1. exportar_evento_kalma genera el paquete firmado del evento para el catálogo de Kalma.
2. preparar_publicacion_kalma prepara una pieza aprobada con texto, imagen y fecha exactos.
3. Pasar paquete y firma a importar_evento_amalia en el MCP de Kalma: primero para ver la propuesta y después para confirmarla.
4. La copia de catálogo queda pendiente de revisión y la pieza opcional es un borrador. Importar no genera otro texto ni publica.
5. registrar_entrega_kalma comprueba el recibo firmado y conserva las referencias.
6. Revisar y publicar mediante las herramientas nativas de Kalma. Su envío comprueba texto, imagen, cuenta, fecha y versión canónica.

Destino comprobado por la conexión de Kalma: negocio 8d07849c-fcc1-43da-90f7-2575b5fe03b5, perfil lumia_8d07849c, Instagram amaliaexperience. Un destino distinto bloquea la entrega.

pausar_entregas_kalma detiene nuevas entregas; las piezas ya programadas se gestionan desde Kalma. Este servicio no publica directamente mediante Meta o Metricool.

## Operación

Identidad Firebase, registro de accesos y clave del puente Kalma en /run/secrets, fuera del código. Accesos distintos para operadora, ingesta y lectura pública de Hermes. No entregar credenciales de operadora a usuarios de negocios.

SQLite operativo en /data mediante volumen persistente. Revisiones de eventos escritas atómicamente en Firestore. npm test usa almacenes y proveedores simulados, sin producción ni publicaciones. La prueba pública requiere una pieza expresamente aprobada.

## Writers externos y revisión de negocios

Los writers de Python y web participan en el mismo protocolo de guardia. Las solicitudes duplicadas de negocios viven solo en `leads_web` y no crean un documento en `eventos` hasta la aprobación expresa por el enlace existente de Telegram. La excepción web vincula firma, candidato y conflictos; una revisión modificada exige confirmar la nueva propuesta. El permiso `admit` del MCP no permite saltarse los conflictos; las excepciones de negocios se tramitan por ese circuito de Telegram.

Las escrituras de contadores que no cambian señales de identidad no necesitan una admisión. Las reglas de clientes deben impedir crear o modificar identidad fuera del backend protegido; las cuentas de servicio no pasan por reglas y requieren el helper de guardia. El despliegue debe comprobar ambos aspectos antes de abrir la guardia. La recuperación operativa consiste en poner `admissionPaused=true` y corregir hacia delante; no restaurar una creación directa sin guardia.

## Admisión de unidades de programas institucionales (2.5.0)

`preparar_programa_oficial` captura y acredita las fuentes; no escribe. Devuelve fichas literales y carencias por unidad. Cada ficha admitible pasa por `preparar_admision` y `admitir_candidato`. En este modo la búsqueda global informa: el origen no descarta coincidencias ni se detiene únicamente por compartir URL. La puerta revalida y conserva todo motivo distinto de URL/sourceId que no haya podido demostrar de otra unidad. La admisión ordinaria conserva su bloqueo previo.

Procedencia automática: proveedor del directorio público de universidades de Castilla y León de la Junta → campo Web de ficha estructurada → página del servicio en la raíz institucional → web del contacto del servicio que enlaza explícitamente el host del programa. El negocio debe estar activo y vinculado a esa institución; su versión se verifica en el commit. Un portal institucional secundario se acredita por enlace explícito de comunicación institucional desde esa raíz o enlace desde el programa; además debe enlazar de vuelta al programa. No basta HTTPS, dominio compartido, URL catalogada ni una ficha previa. No se registra automáticamente una nueva autoridad ni se necesita una aprobación por ficha; otras autoridades/plantillas permanecen no soportadas.

Soporte documental actual: acordeones `x-acc-item` con ámbito de día y periodo anual explícito; sesiones separadas por encabezado/horario, sin autobús/comida/llegada; convocatoria Drupal con campos visibles de fecha/hora/lugar y contraste del atributo datetime. El mediodía de un datetime de fecha no demuestra una hora. Los rangos con horario semanal no están representados íntegramente y se bloquean; el municipio de Huerta Otea no está acreditado por el texto actual y se bloquea. La geografía reconocida se limita a ubicaciones explícitas de Salamanca y sus municipios en estas plantillas. No se promete interpretación universal de programas ni coherencia del nombre de weekday: fecha/mes/año sí se evalúan.

Campos públicos, todos inventariados: título y descripción copiados de la unidad con limpieza de espacios y prefijo horario mecánico; municipio/lugar/provincia/país/zona derivados solo de los campos de actividad acreditados; fecha/hora y fin del tramo convertidos a fecha local/instante; tipo `evento` por actividad programada fechada; precio gratis solo si el programa lo declara para todas las actividades, con texto original conservado, o desconocido. Aforo/categoría/marca/imagen/derechos/aforo/CTA/transporte/consejo sostenible no se infieren: quedan desconocidos/nulos. Los campos aportados que contradigan esa proyección (incluidos dateTime, ubicación estructurada, tipo, precio, aforo, rango o texto editorial) bloquean; no sobreviven mediante spread. Alias del registro, métricas iniciales, actor, versión y fechas técnicas son generados por el servidor. La verificación sigue `capturado`; no se escribe `verificado` ni se aprueba editorialmente. Fuentes, sesión y origen son identidades internas derivadas de la unidad acreditada. `requestId` identifica la entrada original exacta; la propuesta vincula esa entrada, el conjunto de unidades, la autoridad y conflictos. Nada se sustituye por una actividad distinta para reparar una discrepancia.

La identidad de unidad excluye posición, fecha y hora. Repeticiones indistinguibles de título/lugar se bloquean. Se pagina todo catálogo, reservas e historia de ligaduras hasta agotar (máximo 5000); los límites y errores son cerrados. Una fecha/hora cambiada de una ligadura bloquea y no crea otra identidad. Los históricos sin ligadura requieren relación uno-a-uno y hechos coincidentes. Las ligaduras, negocio, snapshots e históricos consultados tienen precondición propia; catálogo, evento, reserva, request, auditoría, snapshots y ligadura se confirman atómicamente. Las carreras normales se reintentan completas en servidor; no dependen de un helper del origen. Una propuesta alterada exige nueva preparación; nunca se reutiliza para otra intención.

Captura: HTTPS con DNS completo validado, conexión fijada a IP validada, SNI/Host originales y peer comprobado; IPs reservadas, CGNAT, mapped/transition IPv6 y redirects a otro host rechazados; timeout total 12s, máximo 262144 bytes por respuesta y 3 redirects, solo HTML UTF8 sin compresión. Snapshot recuperable de todos los saltos con bytes base64, hashes y metadatos; tamaño del documento limitado a 800000 bytes. Evidencias existentes se verifican antes de reutilizarse y en replay; una corrupta no se sobrescribe. Los cambios remotos pueden ocurrir después de una captura: se acredita el snapshot observado, no se promete bloquear transacciones del servidor externo.

`resolver_antecedente_programa` es una decisión HUMANA excepcional para un agrupador histórico, separada de la identidad de sesiones. Requiere `review` y `retire`, vista previa, cobertura literal elegida, hash y versión exactos. Retira recuperablemente y registra cobertura/actor/motivo/snapshots/auditoría en el mismo commit. Solo permite considerar URL/sourceId para unidades nuevas disjuntas; las cubiertas y cualquier otro motivo siguen bloqueados. No acredita oficialidad. La autorización concreta de esta entrega se limita a la ficha agrupada del 9 de noviembre identificada por el propietario; no habilita resolver otros históricos sin autorización.

Pruebas reproducibles: `FIRESTORE_EMULATOR_HOST=127.0.0.1:8686 AMALIA_TEST_PUBLIC_SOURCES=1 node --test --test-concurrency=1 tests/*.test.mjs`. Los tests restringen Firestore a localhost y proyectos demo. El test público recorre HTTP MCP → servicio por defecto → DNS/TLS reales con fuentes públicas y un almacén que rechaza toda escritura. Sin emulador o variable de fuentes públicas se declaran omitidos esos grupos; nunca son certificación de producción. No hacer altas de prueba en PRO.

## 2.24.2
- `editar_evento` respeta `simular=true`: hace todas las validaciones (versión, evidencia, escaneo de duplicados) y devuelve `camposQueCambian`/`cambios` sin escribir. Sin `simular` aplica como siempre.
- `rellenar_url_normalizada.mjs` (ensayo por defecto): rellena `url_normalizada` ausente en fuentes de Instagram.

## 2.24.1
- **Ficha con varias sesiones**: con `sesionId` u `origen` estables, `temporalidad.tipo="sesiones"` guarda TODAS las sesiones en UNA ficha (`sesiones: [{fechaLocal, horaLocal, horaFinLocal}]`, `fechaLocal` = primera, `fechaFinLocal` = última). Los duplicados se comprueban sesión a sesión (los que chocan salen con `sesion`). Sin identidad estable se mantiene una ficha por sesión (lote de 2.24.0). `editar_evento`/`update` acepta `sesiones` para completar fichas ya creadas (`reparar_ficha_sesiones.mjs`).
- Corrección: antes, con sesionId explícito, las N sesiones compartían eventId y solo se guardaba la primera.

## 2.24.0
- **Rendimiento**: plazo interno de 55 s por herramienta (`operation_timeout`, antes de que nginx corte a los 75 s), lectura del catálogo con plazo de 40 s (`catalog_load_timeout`; una carga colgada ya no bloquea las siguientes llamadas) y el registro de fuentes se lee en paralelo y se reutiliza 15 s (se invalida con cualquier escritura propia).
- **Varias sesiones en una llamada** (`temporalidad.tipo="sesiones"`, hasta 60): `preparar_admision` comprueba duplicados sesión a sesión y devuelve un hash; `admitir_candidato` crea las admisibles, omite las bloqueadas (con motivo) y es idempotente (reintentos seguros, presupuesto de tiempo con pendientes).
- **Identidad canónica en eventos**: `updatedBy`, `retiradoPor`, `recuperadoPor` y `actor` de la auditoría se guardan como agente canónico y el principal original en `*Principal`. `createdBy` no cambia. Migración de los eventos existentes en `migrar_identidades.mjs` (ensayo por defecto).
- `recuperar_evento` simula por defecto: aplica solo con `confirmar=true` (`simular=true` fuerza la vista previa).
- `buscar_fuente` acepta `usuario` o `correo` sin `canal` (antes `fuente_busqueda_vacia`).

## 2.23.0
- **Permisos por agente** (valen con cualquiera de sus tokens, se suman al registro de acceso): `alfred` → edit, complete, retire, restore, board, board_admin en todos los negocios; `conchi` → retire y restore. Nunca hay borrado físico: retirar es reversible (`recuperar_evento`) y guarda quién y cuándo. `business_forbidden` por negocioId equivocado devuelve ahora `negocioIdDelEvento`.
- **`fusionar_fuentes`** (solo board_admin): mueve los eventos (campo `fuenteId`, con `fuenteIdAnterior`/`fuenteMovidaPor/En/Motivo`), añade canales y códigos de la duplicada a la destino, conserva el estado más restrictivo y marca la duplicada `fusionada` con `duplicado_de`. Simular por defecto; aplicar exige `codigoConfirmacion`. Si un evento falla no se toca ninguna fuente.
- `lola`: token solo con read, read_public y board.

## Changelog
### 2.22.1
- Duplicados: dos eventos con las mismas palabras significativas en el título (sin artículos ni preposiciones, sin plural, a la raíz de 5 letras) el mismo día, lugar y hora son duplicado aunque el orden o la flexión cambien («Taller de corona navideña» / «Taller Corona de Navidad», caso Noja). Si solo se solapan casi todas las palabras (p. ej. una de más: «Taller infantil de corona navideña») sigue siendo posible_duplicado y se admite. Otra hora, día o recinto, o títulos de una sola palabra, no se tocan.
- preparar_programa_oficial: authority_directory_unsupported y program_provenance_required explican qué falta y la alternativa (preparar_admision). Instrucciones: el modo solo vale para universidades acreditadas en el directorio de la Junta.
- Corrección: url_normalizada de las fuentes ya no se toma de la columna URL de la hoja; reparar_url_normalizada.mjs.

### 2.22.0
- Identidad única por agente (identidad.mjs): mapa de alias → agente canónico (alfred-altas, alfred-ediciones → alfred; amalia-asistente → amalia; conchi-owner → conchi; lola-operator → lola; susan preparada). Al autenticar, cada token lleva `agente` (canónico) y `principalOriginal`; `principal.id` no cambia (recibos e idempotencia). Tablón, tareas, fuentes (responsable, creada_por, modificada_por, historial.por), zonas y mis_pendientes usan solo el canónico y guardan el principal original aparte (*_principal / principal). Los eventos nuevos llevan `agenteCanonico` (createdBy intacto). Lectura robusta: documentos antiguos con alias se muestran ya con el canónico.
- Permisos: Alfred decide (decidir_hilo, asignar_zona, reasignar_fuentes_zona, repartir_fuentes) con cualquiera de sus tokens que tenga `board`.
- Zonas jerárquicas (zonas.mjs): municipio > comarca > zona > provincia > comunidad; manda la más específica. listar_zonas con consultar={provincia|municipio|ccaa}. asignar_zonas_lote (simular/aplicar, nombres normalizados). reasignar_fuentes_zona respeta la jerarquía. repartir_fuentes asigna responsable a las fuentes sin él según el reparto (ubica por municipio si falta la provincia) y devuelve aparte las irresolubles (sinZona).
- listar_altas_recientes: filtro `agente` canónico y campo `agente` en cada alta.
- Migración: migrar_identidades.mjs (ensayo por defecto, aplicar con --confirmo <huella>; no borra; en eventos solo añade agenteCanonico, sin mover la guardia).

### 2.21.0
- Tareas de los agentes (colección tareas_agentes): publicar_tarea, actualizar_tarea, mis_tareas, listar_tareas, resumen_tareas. Cada agente publica lo que hace ahora (en_curso, máx. 5) y lo siguiente (siguiente, máx. 40, ordenadas); estados siguiente → en_curso → hecha, bloqueada (con motivo) o cancelada; historial por tarea. El agente sale del token; solo Alfred (board_admin) crea o modifica tareas de otros. resumen_tareas marca alertas: sin tareas publicadas o sin actualizar en 24 h.

### 2.20.0
- Tablón común de agentes (colección tablon_agentes) y reparto de zonas (zonas_agentes, tablon_lecturas): publicar_mensaje, responder_mensaje, listar_mensajes, mis_pendientes, marcar_leido, resolver_hilo, decidir_hilo, listar_zonas, asignar_zona, reasignar_fuentes_zona.
- Permisos: `board` (leer y escribir; todos los agentes), `board_read` (solo leer; paneles y personas), `board_admin` (Alfred: decidir, asignar zonas, reasignar fuentes con simulación + código de confirmación).
- Alfred decide en caso de duda: duda, ayuda y cambio_zona le llegan siempre. Mensajes inmutables, texto tratado como dato, límite de 30 mensajes cada 10 minutos por agente. Los principales de un mismo agente (alfred, alfred-altas, alfred-ediciones) comparten bandeja.

### 2.19.0
- Repositorio único de fuentes (colección registro_fuentes, ampliada de forma aditiva; el panel actual sigue funcionando). Ver FUENTES.md.
- registrar_fuente: URL normalizada igual = rechazo con el ID existente; solo nombre parecido = alta con aviso posible_duplicado; share.google/acortados rechazados; campos nuevos (tipo, comarca, zona, redes, email, teléfono, frecuenciaDias, notas, codigo F-XXX-0000 con edit). responsable y creador salen del token.
- Nuevas: marcar_revisada, listar_fuentes_vencidas, resumen_fuentes (con rendimiento opcional). actualizar_fuente admite estado (bloqueada exige motivo y licencia), responsable, frecuencia y demás campos; buscar_fuente busca por código/URL normalizada/nombre.
- Altas: campo opcional fuenteId (fte_… o F-XXX-0000) que se guarda en el evento.
- Scripts: migrar_fuentes.mjs (ensayo por defecto; aplicar solo con --confirmo <huella>) y exportar_fuentes_sheet.mjs (hoja de solo lectura regenerada desde Firestore).

### 2.18.0
- Nueva regla de duplicados (admisión y buscar_duplicados_global): solo bloquea lo que coincide en (a) nombre normalizado (minúsculas, sin tildes ni signos, espacios recortados), (b) fecha, (c) lugar (recinto y municipio; recinto vacío o igual al municipio no distingue) y (d) hora, o falta en uno de los dos. Otra hora, fecha o lugar es otro evento. Siguen bloqueando solo la reserva de origen (idempotencia del proveedor) y la identidad calculada (mismo documento). URL, sourceId, sesionId y título contenido pasan a ser informativos.
- Nombre muy parecido (Levenshtein ≥ 0,85 o contenido) con misma fecha, lugar y hora: se admite con `avisos[{tipo:'posible_duplicado',eventId}]` y aparece en `informativas` con confianza `posible_duplicado`.
- buscar_duplicados_global devuelve `traza`, `alcance` (sin filtros, composición por estado) y `barrido`; repite el barrido si el catálogo cambia durante la lectura y marca `exhaustivo=false` + `motivoParcial` si es parcial (límite o catálogo cambiante). Se registra una línea de log con la traza.
- registrar_fuente: si falta la zona en una fuente que no es de municipio, la deduce (municipio que es provincia/región, o otra fuente registrada del mismo municipio) y completa la región desde la provincia; si no puede, `fuente_ambito_sin_zona` con `campoFaltante` y `valoresAceptados`.

### 2.17.0
- Páginas de agenda: una URL (o sourceId) compartida con otra cita es solo un aviso informativo si el candidato trae fecha, título y lugar/ciudad propios y el registro coincidente tiene otro título (no contenido) y otra fecha. Ya no se exige hora ni municipio distinto. Misma fecha: solo si ambas horas constan y difieren. Mismo título, misma fecha sin hora o falta de lugar siguen bloqueando.

### 2.16.2
- Sesión coincidente (sesionId igual) entre municipios distintos es aviso también cuando el sesionId es explícito (caso «A praia do demo» Carnota / obra en Úbeda: AMALIA envió el id genérico de fecha y hora como explícito). Mismo municipio o cualquier señal exacta siguen bloqueando.
### 2.16.1
- Memoria: el contenedor llegaba al límite (256 MB, 1.594 eventos `max` del cgroup, swap) y una llamada tardó 75 s. Lectura del catálogo con menos concurrencia (2) y tramos de 250; nunca dos cargas simultáneas; las escrituras propias con precondición de guardia actualizan la caché en lugar de recargar los ~4.000 eventos. TTL de caché 10 min (la guardia sigue siendo el control principal). Contenedor a 320 MB.
### 2.16.0
- Nueva `listar_altas_recientes` (solo lectura, permiso `read`): eventos por autor (`createdBy`), rango de `fechaCreacion`, provincia, con cursor y limit ≤100; excluye retirados y pruebas.
### 2.15.1
- `editar_evento`: cambiar `city` ya actualiza también `town` y `ubicacion` (antes `canonicalInput` daba prioridad al alias `ubicacion` y el cambio se ignoraba aunque respondía ok).
- Título: se acepta si solo cambia la ciudad incrustada aunque se acorte («…de El Viso del Alcor» → «…de El Viso»); un cambio de significado sigue rechazado.
- `changesJson`: acepta alias (`description`, `nombre`, `town`, `ciudad`, `ubicacion` como texto) y el error `invalid_changes` indica qué campos fallan.
### 2.15.0
- Sesión coincidente entre municipios distintos (sesión implícita, sin otra señal) pasa a aviso (`informativas`); las señales exactas y los sesionId explícitos siguen bloqueando.
- `duplicate_event_conflict` y `admission_contended` conservan su error y añaden `estado` (`review_required` / `contended`); `consultar_recibo_admision` los devuelve (6 h, en memoria).
- `buscar_duplicados_global` incluye `reserva_huerfana` como la admisión.
- Nueva `listar_categorias`. Nueva `actualizar_fuente` (municipio/provincia/ámbito/canal secundario/fusión). `registrar_fuente` acepta `ambito`+`region` sin municipio y `via` multilínea.
- `guardar_imagen`: error `imagen_descarga_fallida` con `causa` (http_403, timeout, dns, conexion, certificado, demasiado_grande). Log con excepción/mensaje/lugar para errores no controlados.
- `subir_imagen_fragmentada`: descripción corregida; acepta `complete` y lo ignora.
### 2.14.0
- Caché del universo del catálogo por versión de guardia (`preparar_admision` ~0,3 s en caliente; carga fría ~10 s en paralelo), precalentada tras cada commit y al arrancar.
- `consultar_recibo_admision` por `requestId` (negocioId opcional) y estado `en_proceso`.

## 2.25.0 — control de duplicados por clave de sesión (SIN DESPLEGAR)

- `clave-sesion.mjs`: clave canónica `municipio|fecha ISO|hora o sin_hora|recinto` (sin título; recinto sin artículos/genéricos solo si queda algún término). Fuerza: fuerte (hora y recinto), media, débil.
- Colección `sesiones_clave/{hash}`: ID = hash de la clave si es fuerte (única en todo el catálogo); si no, incluye el eventId (solo índice). Se crea/borra en el **mismo commit atómico** que el evento (`exists:false`). Retirar libera la clave; recuperar la retoma; editar fecha/hora/recinto la mueve.
- `AMALIA_CLAVES=off|sombra|bloquea` (por defecto `off`). `sombra`: mantiene claves y compara en el log sin bloquear. `bloquea`: preparar/admitir/editar deciden por consultas `municipioFecha` y lecturas puntuales; **no hay escaneos completos ni precarga del catálogo**; `requestId`/`idempotencyKey` obligatorio; `confirmarOtraSesion` deja de poder saltarse avisos.
- Cola `revisar_candidatos` (`listar_revision_candidatos`, `resolver_revision_candidato`, solo `board_admin`): admitir_distinta (con `discriminador` si la clave choca), fusionar o descartar.
- `forbidden` incluye `accionRequerida`; herramientas de escritura y `buscar_duplicados_global` rechazan campos desconocidos (error con el nombre del campo); `buscar_duplicados_global` acepta `municipio`, `desde`, `hasta`; `simular` en admitir_candidato, completar_evento, retirar_evento, resolver_revision_candidato.
- Scripts: `rellenar_claves.mjs` (backfill/reconciliación, ensayo + `--aplicar --confirmo`), `auditoria_duplicados.mjs` (propone; `--encolar`, `--guardar`; `--retirar` es la fase 2, solo con aprobación).
- Tests: `tests/claves-duplicados.test.mjs` (casos reales y concurrencia de 5 altas simultáneas: entra una).

## 2.25.2 — correcciones de la revisión (SIGUE EN SOMBRA)

- Las claves **no se borran** nunca (la cuenta de servicio de Firestore no puede borrar: 403): se **liberan** (`estado:'liberada'`, con precondición de versión) y se retoman. Solo se tocan claves propias (`eventId` igual): retirar un duplicado ya no afecta a la clave de la ficha que se queda.
- `fusionarPar` es **un solo commit atómico** (`FirestoreStore.writeMany`): rellena huecos de la conservada, **mueve las sesiones** que solo tenía la otra, retira la otra y traspasa/libera las claves. `simular` devuelve campos, sesiones, claves y conflictos y comprueba permisos. Ya no pasa por el escaneo de duplicados (adiós `duplicate_event_conflict` contra el propio par).
- Municipio con alias (`Lumbier/Irunberri`, `Donostia`/`San Sebastián`…, tabla ampliable en `clave-sesion.mjs`); una clave por **día** en rangos `fechaLocal`–`fechaFinLocal` (hasta 31 días); el tipo de recinto (teatro, auditorio, museo, iglesia, plaza…) ya no se quita; fecha/hora de eventos antiguos desde `dateTime` en hora de Madrid.
- `rellenar_claves.mjs`: lo que sobra se libera, no se borra.

## 2.25.4 — estado «en pausa» en el panel (SIGUE EN SOMBRA)

- `resumen_tareas` devuelve `estadoPanel` por agente: `en_curso`, `en_pausa` (nada en curso pero con tanda siguiente programada), `bloqueado` (solo si algo depende del propio agente) o `sin_tareas`.
- `actualizar_tarea` acepta `esperaA` al bloquear: una tarea que espera a otra persona no marca al agente como bloqueado. `bloqueadas[]` incluye `esperaA`.
- Permiso `review` añadido al token `amalia-asistente` (solo configuración, sin cambio de código).

## 2.25.3 — reservas sin borrado, alias ampliados, editar_negocio, temporadas (SIGUE EN SOMBRA)

- `moveReserve`: la reserva de origen vieja se **libera** (`estado:'liberada'`, con precondición de versión) y la nueva se crea o retoma una liberada; una reserva liberada equivale a no existir en todas las lecturas. La cuenta de servicio no borra.
- Alias de municipio: tabla fija ampliada (Navarra, País Vasco, Galicia, Cataluña, Comunitat Valenciana, Baleares) sin abreviaturas ambiguas (`sanlucar`, `castellon`, `hospitalet`…) y colección `municipio_alias`: un municipio «A/B» en un evento o negocio guarda A↔B automáticamente y la clave lo lee (caché 5 min).
- `editar_negocio` (permiso `edit`, `simular`, `expectedVersion`, motivo): nombre, dirección, sitioWeb y redes; historial en `negocios/{id}/revisiones`.
- Temporadas: un rango de más de 31 días no genera clave por día ni del primer día: una única marca `temporada` por evento; la auditoría la compara con cualquier sesión del mismo municipio y recinto dentro del rango (título parecido).
