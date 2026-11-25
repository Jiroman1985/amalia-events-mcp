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

## 2.28.0 — vigilancia de ritmo y alertas automáticas
- **`ritmo_altas`** (solo lectura): por agente, altas en la última hora y en 24 h (no cuentan retiradas ni de prueba), contra su objetivo (AMALia 100-200/día, ~10 por hora efectiva), minutos sin altas, `estado` (`en_objetivo`, `por_debajo`, `por_encima`, `parado`, `sin_objetivo`), cola de admisión pendiente con su motivo, tareas en curso, errores de plataforma de 2 h y alertas abiertas.
- **Alertas del servidor en el tablón** (hilo `ayuda`, urgente, para Alfred; el servidor las revisa cada 5 min): (1) un agente con objetivo lleva más de 2 h sin altas y tiene cola pendiente o tareas en curso; (2) el mismo error de configuración o plataforma se repite 3 veces en 15 min en un agente (con `esperaA: "inaki"`, porque es del servidor). Una sola alerta abierta por agente y asunto (`alerta_clave`), y se cierra sola (`resuelto_por: sistema`) cuando la condición desaparece: el agente vuelve a dar altas o el error deja de repetirse. Las dudas/ayudas nunca se autocierran por lectura: solo las cierra el servidor al resolverse la causa.
- **Turno**: el reloj de «sin altas» solo corre dentro del turno del agente (por defecto 08:00-22:00, hora de Madrid; `AMALIA_TURNO_ALTAS="8-22"` o `"turno"` dentro de su objetivo). Fuera de turno no se abren alertas de ritmo y una alerta ya abierta no se cierra por ser de noche: solo se cierra cuando la causa desaparece. Al empezar el turno, si la causa sigue (p. ej. 2 h de turno sin altas con cola pendiente), avisa. `ritmo_altas` informa `minutosSinAltasEnTurno`, `turno` y `enTurnoAhora`. Las alertas de errores repetidos del servidor no dependen del turno.

| Variable | Defecto | Efecto |
|---|---|---|
| `AMALIA_VIGILANCIA_MS` | `300000` | cada cuánto el servidor revisa el ritmo y abre/cierra alertas (0 = desactivada) |
| `AMALIA_OBJETIVOS_ALTAS` | `{"amalia":{"min":100,"max":200,"horasEfectivas":10}}` | objetivos de altas por día y agente (JSON; si no es válido se usan los de por defecto con aviso en el log) |
| `AMALIA_ALERTA_SIN_ALTAS_MS` | `7200000` | tiempo de TURNO sin altas que dispara la alerta de ritmo |
| `AMALIA_TURNO_ALTAS` | `8-22` | turno (hora de Madrid) en el que corre el reloj de «sin altas» |
| `AMALIA_ALERTA_ERRORES_N` | `3` | repeticiones del mismo error que disparan la alerta |
| `AMALIA_ALERTA_ERRORES_VENTANA_MS` | `900000` | ventana de esas repeticiones |

## 2.27.0 — represado en la misma llamada, admitir_lote y alta en serie
- **Represado en la misma llamada**: si `admitir_candidato` recibe un hash caducado se vuelve a preparar dentro de la misma llamada, SOLO si la propuesta es materialmente la misma y no hay duplicado nuevo: (a) otra alta de la misma fuente movió la versión del documento de la fuente (`registro_source_changed`) y el hash recibido es exactamente el de esos mismos campos con la versión anterior; (b) cambió el catálogo y el agente envía `huellaCampos` (la de `preparar_admision`) idéntica a la actual. Devuelve `represado:true`, `motivoRepresado` y `proposalHashFinal`. Un campo cambiado sigue dando `proposal_changed`; una coincidencia nueva sigue dando `duplicate_event_conflict`.
- **`admitir_lote`**: hasta 25 candidatos preparados (`evento` + `proposalHash` + `huellaCampos` opcional). Cada uno es una admisión normal (escaneo indexado por fecha+municipio+fuente, commit atómico con guardia) y sale `admitido`, `omitido` (duplicado/ya existía), `encolado` (fallo de plataforma), `error` o `pendiente` (si no cabe en `AMALIA_LOTE_ADMISION_MS`; se repite solo eso). Un fallo no tumba el lote. Compatible con el límite de 55 s de la herramienta.
- **Alta en serie**: las altas de ESTE servidor ya no compiten entre sí por la guardia del catálogo (sección crítica = escaneo + commit). Solo los escritores externos pueden provocar `version_conflict`, que se reintenta hasta `AMALIA_ADMISION_INTENTOS` veces con pausa aleatoria.
- **Tiempos medidos contra el catálogo real (solo lectura)**: `preparar_admision` 0,45–0,9 s (mediana 0,76 s; 1,6 s en frío) con 1-16 candidatos escaneados; una lectura de Firestore tarda ~0,37 s ida y vuelta. Muy por debajo de 10 s: no hace falta caché ni índice nuevos (el escaneo ya es por rango de fechas, no recorre el catálogo). Si una alta pasa de `AMALIA_ADMISION_LENTA_MS` se registra `admision_lenta` en el log y `salud_admision` muestra media, p95 y máximo.
- Prueba de carga: `node carga_admision.mjs --minutos 10 --agentes 3 --externo-ms 3000` (almacén en memoria con latencia simulada; este servidor no tiene emulador de Firestore).

| Variable | Defecto | Efecto |
|---|---|---|
| `AMALIA_ADMISION_INTENTOS` | `5` | reintentos por `version_conflict` de la guardia antes de `admission_contended` |
| `AMALIA_ADMISION_SERIE` | activa (`off` la desactiva) | altas de este servidor de una en una |
| `AMALIA_LOTE_ADMISION_MS` | `45000` | presupuesto de tiempo de `admitir_lote` |

## 2.26.0 — fiabilidad de la admisión: config degradable y cola persistente
Ningún fallo de configuración o de plataforma deja a un agente a 0 durante horas: lo degradable se degrada con aviso y lo bloqueado se encola y se reanuda solo.
- **Procedencia degradable**: si `procedenciaRegistro` no se puede validar por CONFIGURACIÓN (`registro_cutoff_unconfigured`, `registro_cutoff_not_reached`) el alta NO se bloquea: entra sin procedencia, con `procedenciaPendiente=true`, `procedenciaPendienteMotivo` y los datos validados en `procedenciaPendienteDatos`, y se escribe un aviso `procedencia_degradada` en el log. Los errores de DATOS (`registro_primary_mismatch`, `registro_source_identity_mismatch`, `registro_source_not_found`, `registro_provenance_invalid`, `registro_source_ineligible`…) siguen bloqueando ese evento. `reconciliar_procedencias` (y el servidor cada 10 min) adjunta la procedencia cuando el corte vuelve; si la fuente cambió de versión pero sigue siendo válida se reenlaza a la versión actual.
- **`salud_admision`** (solo lectura): corte, guardia del catálogo, `admissionPaused`, tamaño del universo, modo de claves, latencia media/p95 de preparar y admitir, errores de plataforma de las últimas 2 h por código y cola pendiente. `operativa` = se puede admitir; `estado` verde/amarillo/rojo.
- **Cola persistente `cola_admision`**: si `preparar_admision`/`admitir_candidato` fallan por un código reintentable (`admission_paused`, `catalog_guard_unavailable`, `operation_timeout`, `catalog_load_timeout`, `admission_contended`, `incomplete_scan`, red/5xx de Firestore) el candidato se guarda con su evento, requestId y motivo y la herramienta devuelve `encolado:true` (no un error). `reanudar_cola_admision` (y el servidor cada 10 min) vuelve a preparar y admitir lo encolado cuando la guardia está operativa: idempotente por requestId, con el escaneo de duplicados normal; un duplicado nuevo se omite. Publica una nota en el tablón para el agente afectado y para Alfred. `listar_cola_admision` la consulta.
- `preparar_admision` deja de estar marcada `readOnlyHint` (puede escribir en la cola cuando falla por plataforma); `salud_admision`, `listar_cola_admision` y `ritmo_altas` sí son de solo lectura.
- Un error de plataforma **no es «espera aviso»**: está en las instrucciones del MCP y en la descripción de las herramientas.

### Variables de entorno nuevas (valor por defecto)
| Variable | Defecto | Efecto |
|---|---|---|
| `AMALIA_COLA` | activa (`off` la desactiva) | cola persistente y worker |
| `AMALIA_COLA_MS` | `600000` | cada cuánto el servidor reanuda la cola y reconcilia procedencias (0 = no) |
| `AMALIA_COLA_PRESUPUESTO_MS` | `40000` | tiempo máximo de cada pasada de reanudación |
| `AMALIA_COLA_MAX_INTENTOS` | `20` | tras esos intentos la entrada pasa a `bloqueada` |
| `AMALIA_PLAZO_LLAMADA_MS` | `50000` | plazo interno de preparar/admitir: vence antes que el de la herramienta (55 s) para poder encolar |
| `AMALIA_ADMISION_LENTA_MS` | `10000` | umbral para registrar `admision_lenta` en el log |

### Errores que dependen de config/entorno y su tratamiento
| Código / variable | Tratamiento |
|---|---|
| `registro_cutoff_unconfigured` (`AMALIA_FUENTES_V2_DESDE_ISO` mal formada) | se degrada: alta sin procedencia + `procedenciaPendiente`; aviso en log; `salud_admision` amarillo |
| `registro_cutoff_not_reached` (corte en el futuro) | se degrada igual |
| variable ausente | corte por defecto `2026-11-22T00:00:00Z` + aviso (2.25.21) |
| `catalog_guard_unavailable` | se encola; salud rojo; el worker espera |
| `admission_paused` (decisión humana) | se encola; salud rojo; se reanuda al reabrir |
| `operation_timeout`, `catalog_load_timeout`, `admission_contended`, `incomplete_scan`, `firestore_http_5xx/429`, red | se encolan (reintentables) |
| `AMALIA_CLAVES` con valor desconocido | no falla; `salud_admision` lo marca amarillo (`modoClaves`) |
| `AMALIA_UNIVERSE_MAX_DOCS` superado (`catalog_limit_exceeded`) | no reintentable; `salud_admision` avisa al 90 % |
| `firestore_http_403` (permisos de la cuenta de servicio) | no reintentable: error visible, no se encola |
| `MCP_TOKEN`/credenciales ausentes | el servidor no arranca (fallo visible en el despliegue) |

## 2.24.2
- `editar_evento` respeta `simular=true`: hace todas las validaciones (versión, evidencia, escaneo de duplicados) y devuelve `camposQueCambian`/`cambios` sin escribir. Sin `simular` aplica como siempre.
- `rellenar_url_normalizada.mjs` (ensayo por defecto): rellena `url_normalizada` ausente en fuentes de Instagram.

## 2.24.1
- **Ficha con varias sesiones**: con `sesionId` u `origen` estables, `temporalidad.tipo="sesiones"` guarda TODAS las sesiones en UNA ficha (`sesiones: [{fechaLocal, horaLocal, horaFinLocal}]`, `fechaLocal` = primera, `fechaFinLocal` = última). Los duplicados se comprueban sesión a sesión (los que chocan salen con `sesion`). Sin identidad estable se mantiene una ficha por sesión (lote de 2.24.0). `editar_evento`/`update` acepta `sesiones` para completar fichas ya creadas (`reparar_ficha_sesiones.mjs`).
- Corrección: antes, con sesionId explícito, las N sesiones compartían eventId y solo se guardaba la primera.

## 2.24.0
- **2.25.21**: el corte del registro de fuentes (`AMALIA_FUENTES_V2_DESDE_ISO`) tiene valor por defecto `2026-11-22T00:00:00Z` con aviso en el log si falta (antes `preparar_admision` con `procedenciaRegistro` fallaba con `registro_cutoff_unconfigured`); `capacidades_registro_fuentes` devuelve `cutoffPorDefecto`. En producción la variable está definida explícitamente.
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

## 2.25.20 — claves: ficha con periodo no bloquea sesiones sueltas (SIGUE EN SOMBRA)

- Las claves de los días de una ficha con **periodo** (fechaLocal–fechaFinLocal de hasta 31 días, sin `sesiones` explícitas) llevan `periodo: true` y `periodoFin`. En `decidirSesion`, una ficha con periodo frente a una sesión suelta (o al revés) **nunca bloquea**: va a la cola (`sesion_suelta_y_ficha_con_periodo`). Dos fichas con periodo, o dos sesiones sueltas, siguen igual (bloquea). `rellenar_claves` cuenta como «cambiar» las claves a las que falta o sobra el marcador.
- Test del caso Moi Animal (Burela): dos funciones a distinta hora no se bloquean por el cruce de horas (título igual → libre; título reescrito frente a otra hora → solo aviso/cola); el bloqueo viene únicamente de la gemela de la misma hora.

## 2.25.19 — los agentes de baja no pueden ser destinatarios (SIGUE EN SOMBRA)

- `publicar_mensaje` y `responder_mensaje` rechazan como destinatario a cualquier agente de `AGENTES_BAJA` (alias y mayúsculas incluidos) con `board_destinatario_baja` (`agentes`, `ayuda`). Las respuestas y decisiones por defecto en hilos antiguos omiten a los agentes de baja en vez de fallar.
- `publicar_tarea` rechaza asignar o publicar una tarea a un agente de baja con `tarea_agente_baja`.
- Se retiró `~/tokens-ingesta/alfie.token`.

## 2.25.18 — baja del agente alfie (SIGUE EN SOMBRA)

- `alfie` sale de `AGENTES` (identidad.mjs) y de `AGENTES_CONOCIDOS` (tareas.mjs): ya no aparece en `resumen_tareas` ni genera la alerta `sin_tareas_publicadas`, y no cuenta como lector de los avisos a «todos». `AGENTES_BAJA = ['alfie']` conserva su identidad: `agenteCanonico('alfie')` sigue siendo `alfie`, y createdBy/updatedBy/autor «alfie» se siguen leyendo y contando en listados de días pasados; sus tareas siguen guardadas y listables con `listar_tareas`.
- Token de `alfie` revocado (entrada eliminada de `access.json`: 401). Los demás no se tocan.
- La fuente activa con responsable alfie pasa a noodle (actualizar_fuente, con motivo y auditoría); las fusionadas conservan su responsable histórico.

## 2.25.17 — requiere_atencion guardado en Firestore (SIGUE EN SOMBRA)

- Campo booleano **`requiere_atencion`** en el documento **raíz** de cada hilo de la colección **`tablon_agentes`** (las respuestas no lo llevan). Valor = abierto && urgente && (tipo duda, ayuda o cambio_zona, o con `espera_a`).
- Se escribe al publicar y al cerrar (resolver, decidir, autocierre) y se recalcula tras responder, decidir, `marcar_leido` y en el barrido de 5 min (`barrido`: autocierre + recálculo de todas las raíces). Solo se reescribe la raíz si el valor guardado difiere.
- `backfill_requiere_atencion.mjs` (dry-run por defecto; `--aplicar --confirmo <huella>`) rellena los hilos existentes.

## 2.25.16 — tablón: autocierre, límite y requiereAtencion (SIGUE EN SOMBRA)

- **Autocierre en servidor** (`autocerrar`, en `tablon.mjs`): los hilos aviso, nota y asignacion abiertos se cierran solos (`resuelto_por: "sistema"`, `nota: "autocierre"`, `autocierre_motivo`: `leido_por_todos` | `seis_horas`) cuando todos sus destinatarios los han leído (marca de lectura posterior al último mensaje de otros; «todos» = todos los agentes; el autor no cuenta) o a las 6 h de creados. duda, ayuda, cambio_zona (y evento, decision, respuesta) nunca se autocierran. Se aplica al listar, en `mis_pendientes` y `marcar_leido`, y con un barrido cada 5 min (`AMALIA_AUTOCIERRE_MS`, 0 lo desactiva). Primer barrido: unos 14 hilos antiguos abiertos se cerrarán.
- **Límite de 30 mensajes/10 min:** `resolver_hilo` (incluida su nota) y `marcar_leido` no cuentan.
- **`requiereAtencion`** en `listar_mensajes` (por hilo y en la vista de hilo) y `mis_pendientes`: abierto + prioridad urgente + (tipo duda, ayuda o cambio_zona, o con `esperaA`). Los hilos admiten `esperaA` opcional en `publicar_mensaje`. Ambas respuestas incluyen `requierenAtencion` (recuento). Además `listar` muestra `resueltoPor` y `nota` en hilos resueltos.

## 2.25.15 — el alta exige fechaLocal ISO, municipio y provincia (SIGUE EN SOMBRA)

- `preparar_admision` y `admitir_candidato` (también simulación, lote de sesiones y eventos de programas) rechazan el alta si falta alguno: `missing_field` con `campo` = `fechaLocal` | `municipio` | `provincia` y una ayuda. Un `fechaLocal` que no sea AAAA-MM-DD da `invalid_local_date` (campo y formato).
- `city`, `town`, `ciudad`, `municipio` y `ubicacion` (texto u objeto), si vienen, deben coincidir entre sí (sin importar mayúsculas ni tildes): si no, `conflicting_location` con el campo que discrepa.
- Municipio = `city` o `ubicacion.municipio`; provincia = `provincia` o `ubicacion.provincia`. Las ediciones de eventos existentes no cambian.

## 2.25.14 — consulta de candidatos solo por fechaLocal (SIGUE EN SOMBRA)

- Backfill aplicado: `backfill_normalizar.mjs` en dry-run da 0 cambios (5.006 eventos; 4.533 con `fechaLocal`). Los 473 restantes no tienen ninguna fecha utilizable (sin fecha, «Hasta el…», UTC ambiguo…), así que tampoco podían coincidir por fecha.
- `candidateUniverse` consulta una sola vez por ventana, sobre `fechaLocal` (antes también `fecha_inicio` y `dateTime`). Todo escritor externo debe rellenar `fechaLocal`; `node backfill_normalizar.mjs` (dry-run) sirve de comprobación periódica.

## 2.25.13 — url_titulo sin fecha exige municipio; backfill con reintento (SIGUE EN SOMBRA)

- `url_titulo`: cuando uno de los dos no tiene fecha, también exige el mismo municipio para bloquear; con otro municipio es aviso.
- `aplicarPlan` (backfill): un lote que falla se reintenta documento a documento y, si ya existe una revisión con la versión siguiente (historial incoherente con el documento), usa la siguiente libre.

## 2.25.12 — url_titulo más preciso (SIGUE EN SOMBRA)

- `url_titulo` (misma URL de origen + mismo título normalizado) solo **bloquea** si además es el mismo municipio y la fecha dista ≤1 día, o si uno de los dos no tiene fecha. Con otro municipio u otro día es aviso (`url_fuente_otra_sesion`): giras (p. ej. «Zambomba flamenca navideña con Duende Nazarí» en Gorafe, Játar y Ventas de Huelma) y ciclos semanales comparten URL y título. Sigue exento un evento por sesiones o con `sesionId` explícito distinto en ambos.
- Backfill aplicado en parte (2.671 de 2.771 eventos); quedan 100 pendientes de aprobación.

## 2.25.11 — URL de origen + título bloquea; backfill más estricto (SIGUE EN SOMBRA)

- **Bloqueo por URL + título:** si el candidato comparte URL de origen Y título normalizado (`claveNombre`: sin tildes, mayúsculas ni signos) con un evento existente, la coincidencia es bloqueante (`url_titulo`) aunque la fecha, la hora o el lugar sean otros. Solo la URL sigue siendo aviso (`url_fuente_otra_sesion`). Excepciones: el candidato es una sesión de un evento por sesiones (`temporalidad.tipo='sesiones'`) o ambos declaran un `sesionId` explícito distinto. Salida legítima para otra sesión de la misma página: `confirmarOtraSesion` (sesionId explícito + evidenciaUrl) en modo legacy; en modo `bloquea` decide Alfred por la cola.
- **Backfill:** las fechas de texto exigen una fecha completa (o rango/lista de días: se toma el inicio); «Hasta el…», «a partir del…» y similares se omiten. La provincia solo se infiere si ≥2 eventos del catálogo respaldan el municipio.

## 2.25.10 — altas recientes indexadas, URL de origen y backfill de normalización (SIGUE EN SOMBRA)

- **`listar_altas_recientes`** ya no recorre el catálogo: consulta por rango de `fechaCreacion` (descendente, índice de campo único), con `desde`/`hasta` en la consulta y el resto de filtros (autor, agente, provincia, permisos) sobre las filas de la ventana. Devuelve `totalExacto` (false si la ventana supera `AMALIA_ALTAS_MAX_LECTURAS`, 5.000: acota con desde/hasta). Los eventos antiguos sin `fechaCreacion` no se listan. El cursor pasa a `fechaCreacion|id` (los numéricos antiguos se siguen aceptando).
- **Misma URL de origen:** `preparar_admision` busca por igualdad indexada en `link` y `enlace_original` (hasta 10 URLs del candidato, 500 filas por URL) y añade esos eventos al universo aunque estén fuera de la ventana de ±1 día ni del mismo municipio: un reingreso con la fecha mal leída aparece como `url_fuente_otra_sesion` (informativo, como antes). No se cubren URLs que solo estén en `fuentes[1..]`.
- **`backfill_normalizar.mjs`** (dry-run por defecto; `--aplicar --confirmo <huella>`): rellena `fechaLocal` (de `fecha_inicio`, `dateTime` ISO con desfase o texto «22 de marzo de 2026»; los instantes UTC se omiten por ambiguos), `city` (de ciudad/town/ubicación) y `provincia` (de `ubicacion.provincia` o la única provincia del municipio en el catálogo). Nunca pisa valores; escribe en lotes atómicos con versión+1, auditoría y guardia, y marca `normalizacion_backfill_v1`.

## 2.25.9 — admisión sin escanear el catálogo (SIGUE EN SOMBRA)

- **Causa:** `preparar_admision`/`admitir_candidato` leían los ~5.000 eventos para comparar y, al superar el tope, daban `incomplete_scan` / `catalog_limit_exceeded`.
- **Ahora** (`EventService.candidateUniverse`): la guardia se lee primero y solo se consultan los candidatos posibles: eventos con fecha de sesión entre -1 y +1 día de cada sesión del candidato (consultas por rango sobre `fechaLocal`, `fecha_inicio` y `dateTime`, que cubren documentos canónicos y legacy), sin los pasados (la ventana empieza hoy), y limitados al mismo municipio (con alias) o a la misma provincia; más lecturas puntuales de la identidad calculada y de la reserva de origen. Los documentos sin municipio se conservan (fail-closed).
- El tope de 5.000 desaparece del camino de admisión y de las ediciones con escaneo. `buscar_duplicados_global` y la admisión de programas siguen recorriendo todo el catálogo, con tope de seguridad `AMALIA_UNIVERSE_MAX_DOCS` (100.000 por defecto).
- **Índices** (`firestore.indexes.json`): solo campos únicos (`fechaLocal`, `fecha_inicio`, `dateTime`), que Firestore crea por defecto; no hace falta ningún índice compuesto. Despliegue opcional: `firebase deploy --only firestore:indexes`.
- Tests: `tests/admision-indexada.test.mjs` (catálogo de 5.200 eventos donde listar `eventos` está prohibido).

## 2.25.8 — agente Noodle (SIGUE EN SOMBRA)

- Nuevo agente `noodle` (mismos permisos que Conchi): reconocido en `AGENTES` y `AGENTES_CONOCIDOS`, aparece en `resumen_tareas`.

## 2.25.7 — precio desconocido en editar_evento (SIGUE EN SOMBRA)

- `editar_evento` acepta `precio` (también `null`), `precioEstado` y `precioDetalle` (texto u objeto), que se traducen a `precioInfo`. `precio:null` o `precioEstado:"desconocido"` deja el precio como desconocido (la app muestra «Consultar precio»). Antes daba `invalid_changes`.

## 2.25.6 — agente Rene (SIGUE EN SOMBRA)

- `rene` se añade a los agentes conocidos: aparece en el panel (`resumen_tareas`) desde el primer momento. Token con los permisos de Conchi (admit, read, register_source, create_business, complete, board).

## 2.25.5 — lote de ediciones (SIGUE EN SOMBRA)

- `editar_evento`: acepta `fuenteId` (debe existir en `registro_fuentes`), `link` (exige `evidenciaUrl`) y `sesiones` (solo AÑADE sesiones: lista completa que incluya las existentes, sin anteriores a la fecha principal; exige evidenciaUrl, escaneo de duplicados y ajusta `fechaFinLocal`).
- `editar_negocio`: `sitioWeb:null` lo quita (el negocio debe conservar otra fuente pública).
- `decidir_hilo`: valida `decision` (obligatoria, texto de 1 a 2000) con `board_decision_requerida` / `board_decision_invalida`.
- `arrancar.sh`: arranque del contenedor con `/home/ec2-user/amalia-events.env` (chmod 600, fuera del repo).

## 2.25.4 — estado «en pausa» en el panel (SIGUE EN SOMBRA)

- `resumen_tareas` devuelve `estadoPanel` por agente: `en_curso`, `en_pausa` (nada en curso pero con tanda siguiente programada), `bloqueado` (solo si algo depende del propio agente) o `sin_tareas`.
- `actualizar_tarea` acepta `esperaA` al bloquear: una tarea que espera a otra persona no marca al agente como bloqueado. `bloqueadas[]` incluye `esperaA`.
- Permiso `review` añadido al token `amalia-asistente` (solo configuración, sin cambio de código).

## 2.25.3 — reservas sin borrado, alias ampliados, editar_negocio, temporadas (SIGUE EN SOMBRA)

- `moveReserve`: la reserva de origen vieja se **libera** (`estado:'liberada'`, con precondición de versión) y la nueva se crea o retoma una liberada; una reserva liberada equivale a no existir en todas las lecturas. La cuenta de servicio no borra.
- Alias de municipio: tabla fija ampliada (Navarra, País Vasco, Galicia, Cataluña, Comunitat Valenciana, Baleares) sin abreviaturas ambiguas (`sanlucar`, `castellon`, `hospitalet`…) y colección `municipio_alias`: un municipio «A/B» en un evento o negocio guarda A↔B automáticamente y la clave lo lee (caché 5 min).
- `editar_negocio` (permiso `edit`, `simular`, `expectedVersion`, motivo): nombre, dirección, sitioWeb y redes; historial en `negocios/{id}/revisiones`.
- Temporadas: un rango de más de 31 días no genera clave por día ni del primer día: una única marca `temporada` por evento; la auditoría la compara con cualquier sesión del mismo municipio y recinto dentro del rango (título parecido).
