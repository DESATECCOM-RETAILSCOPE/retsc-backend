# Inventario de deuda técnica y pendientes — retsc-backend

**Fecha del escaneo**: 2026-08-04. **Alcance**: `Backend/retsc-backend/src/`, `CLAUDE.md`, `docs/*.md`, y (solo lectura) `Functions/src/`.

Este es un inventario, no un plan de trabajo — nada se corrigió en esta pasada. Cada ítem tiene una fuente real (comentario de código, doc, o patrón concreto verificado); no se inventó ningún pendiente.

**`Functions/` (repo hermano)**: escaneado, prácticamente sin deuda — un solo falso positivo (`PENDING` como valor de estado, no un marcador de pendiente). No se lista aparte.

---

## 🔴 Severidad alta — puede romper o corromper datos en producción

### 1. `is_active` no único por categoría en `RETSC_AI_DETECTION_MODELS`
- **Tipo**: bug conocido (falta de constraint).
- **Ubicación**: `docs/BUG-is_active-no-unico.md`; código afectado en `src/repositories/aiModelRepo.js` (`findByCategoryId`), `src/services/annotationSyncService.js`, `src/services/modelTrainingService.js` (`startTraining`), `src/services/shelfPhotoUploadService.js` (Etapa 6).
- **Qué implica**: nada en la BD impide más de una fila `is_active=1` por `category_id`. Si eso pasa, `findByCategoryId` devuelve la fila que el motor SQL decida, no necesariamente la correcta — **ya causó un incidente real** en pruebas contra producción (`category_id=36`, actualizó el modelo equivocado). Con el flujo automático ya cableado, esto determina qué modelo recibe el disparo de training/publicación.
- **Bloqueado por**: decisión de equipo (índice único filtrado vs. transacción explícita) — la causa raíz requiere auditar filas existentes antes de crear el índice. La mitigación parcial (envolver `setActiveVersion` en una transacción) es pura lógica y no requiere esa decisión — ver ítem 2.

### 2. `aiModelRepo.setActiveVersion()` — dos UPDATEs sin transacción
- **Tipo**: deuda técnica / falta de atomicidad.
- **Ubicación**: `src/repositories/aiModelRepo.js` (`setActiveVersion`, comentario propio reconoce el gap).
- **Qué implica**: "desactivar todas → activar una" no es atómico — una falla o concurrencia entre esos dos UPDATEs puede dejar una categoría sin ninguna fila activa, o con dos. Es la causa de fondo del ítem 1.
- **Bloqueado por**: nada — resolvible ya envolviendo en `pool.transaction()` (mismo patrón que `enterpriseCategoryRepo.js`, la única transacción explícita existente en el repo).

### 3. Race condition de doble-submit en sync a Custom Vision
- **Tipo**: falla conocida, no resuelta (concurrencia).
- **Ubicación**: `src/services/annotationSyncService.js:130-142` (comentario extenso documentando el caso).
- **Qué implica**: si dos requests concurrentes llegan al punto de `splitByCvRegionId` antes de que el primero persista `cv_region_id`, ambos ven `cv_region_id=NULL` para las mismas anotaciones y ambos crean la región — **duplicado real en Custom Vision**, no solo trabajo redundante.
- **Bloqueado por**: decisión de equipo — el propio comentario dice "no se toca estructura de tablas en este ajuste sin acordarlo antes"; la mitigación (UPDATE optimista o constraint) es pura lógica+schema, pero deliberadamente no se implementó hasta confirmar que el caso ocurre en la práctica (no solo en teoría).

### 4. Caso borde — cajitas con coordenadas idénticas tumban el sync completo de la foto
- **Tipo**: bug conocido, documentado, no resuelto.
- **Ubicación**: `src/services/annotationSyncService.js` (comentario "CASO BORDE").
- **Qué implica**: si dos anotaciones de una misma foto tienen exactamente el mismo `bbox_left/top/width/height`, Custom Vision rechaza el batch **entero** con `400 Duplicate image regions` — marca la foto entera como `cv_sync_status='ERROR'`, no solo las cajitas duplicadas. El usuario ve un error genérico de CV, no algo explícito de "cajitas duplicadas".
- **Bloqueado por**: nada técnicamente — es una validación que se podría agregar antes de mandar el batch a CV, pero requiere decidir qué hacer con las cajitas duplicadas (¿rechazar la corrección? ¿moverla automáticamente?) — decisión de producto menor, no de infra.

---

## 🟡 Severidad media — degrada calidad, mantenibilidad o exactitud de la documentación

### 5. `shelfPhotoUploadService.js` sigue usando `CV_TAG_*` (Issue #35 solo PARCIALMENTE resuelto) — **hallazgo nuevo, corrige una afirmación previa**
- **Tipo**: deuda técnica / inconsistencia entre dos partes del código.
- **Ubicación**: `src/services/shelfPhotoUploadService.js:63-73` (`resolveTagId(canal)`) y línea 233 (`resolveTagId(canal)` llamado sin `projectId`).
- **Qué implica**: el cableado de Issue #35 (spec v1.4, sesión anterior) reemplazó `resolveTagId()` por `customVisionService.ensureTag(projectId, canal)` **solo en `annotationSyncService.js`** (usado al sincronizar anotaciones aprobadas). `shelfPhotoUploadService.js` tiene su **propia copia independiente** de la misma función vieja, que sigue leyendo `CV_TAG_OMT/DTT/CONVENIENCE` (vacías en `.env`) y devuelve `null` — usada en la Etapa 6 (registro inicial de la imagen en Custom Vision, `createImageFromData`). Como el parámetro es opcional y las regiones (que sí llevan el tag correcto) se agregan después en el sync, esto **no rompe el pipeline hoy**, pero significa que la afirmación "Issue #35 resuelto, `CV_TAG_*` ya no se lee en ningún lado" (documentada en `CLAUDE.md`) es **incompleta** — corregir esa documentación y, si se quiere consistencia real, reemplazar esta segunda copia por `ensureTag()` también.
- **Bloqueado por**: nada — resolvible ya, mismo patrón que ya existe en `annotationSyncService.js`.

### 6. Comentarios que afirman "migración 006 NO aplicada" — desactualizados
- **Tipo**: deuda de documentación (comentarios de código desincronizados del estado real).
- **Ubicación**: `src/repositories/aiModelRepo.js:235`, `src/services/modelTrainingService.js:40,49,192,207,213`, `src/services/modelVersioningService.js:16,37`, `src/repositories/dashboardRepo.js:251,253`, `src/routes/dashboardRoutes.js:60`.
- **Qué implica**: la migración 006 (`precision_score`/`recall_score`/`mean_ap`/`metrics_json`) **fue aplicada exitosamente contra `sqldb-rscope-prod`** en esta misma sesión (verificado con `INFORMATION_SCHEMA` antes y después). El código ya funciona correctamente sin cambios (el `try/catch` de `saveMetrics()` no depende de que el comentario sea correcto), pero los comentarios siguen afirmando que la migración no corrió — engañoso para quien lea el código y asuma que las métricas todavía no se pueden persistir.
- **Bloqueado por**: nada — es un fix de comentarios, cero riesgo.

### 7. `docs/TODO-menu-roles.md` desactualizado — el trabajo ya se hizo
- **Tipo**: deuda de documentación.
- **Ubicación**: `docs/TODO-menu-roles.md` (dice "Estado: pendiente"); contradice `CLAUDE.md` sección "Menú por rol (F4)" y su ítem `### 16. ~~Menu reordering...~~ — UNBLOCKED 2026-07-25`.
- **Qué implica**: el archivo standalone nunca se actualizó/eliminó tras resolverse — alguien que lea solo ese `.md` (sin cruzar contra `CLAUDE.md`) creería que el reordenamiento del menú sigue bloqueado esperando diseño de la dueña, cuando ya se implementó.
- **Bloqueado por**: nada — actualizar o borrar el archivo.

### 8. `azureVisionService.js` — stub permanente ignorando credenciales reales
- **Tipo**: stub incompleto / limitación documentada.
- **Ubicación**: `src/services/azureVisionService.js` (`analyzeCaption()`, `isShelf()`); también `CLAUDE.md` ítem `### 11`.
- **Qué implica**: aunque `AZURE_VISION_ENDPOINT`/`KEY` estén configuradas, ambas funciones devuelven resultados permisivos (`accepted:true`/`isShelf:true`) sin llamar al SDK real — el gate de calidad de fotos de góndola nunca rechaza por caption/contenido.
- **Bloqueado por**: trabajo de código puro (instalar `@azure-rest/ai-vision-image-analysis` + implementar 2 llamadas) — no depende de credenciales nuevas (ya están, según el diagnóstico previo), solo de tiempo de desarrollo.

### 9. `TRAINING_ADMIN_ROLES` y `CV_TAG_*` sin uso tras las limpiezas de esta sesión
- **Tipo**: config hardcodeada / env vars huérfanas.
- **Ubicación**: `.env`/`.env.example`; documentado en `CLAUDE.md`.
- **Qué implica**: `TRAINING_ADMIN_ROLES` gateaba el endpoint de training manual, retirado — ningún archivo lo lee hoy. `CV_TAG_OMT/DTT/CONVENIENCE` iban a quedar sin uso tras el cableado de tags on-demand, pero ver ítem 5 — **sí tienen un lector real** (`shelfPhotoUploadService.js`), aunque están vacías en `.env` así que en la práctica no aportan nada hoy.
- **Bloqueado por**: nada — limpieza de env vars cuando se quiera, no urgente.

### 10. Logs de debug temporales activos en producción
- **Tipo**: falla silenciosa / higiene de logs, marcado explícitamente como "borrar después".
- **Ubicación**: `src/config/db.js:27-31,43,55` (`[DB DEBUG]` — imprime `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER`, y si `SQL_PASSWORD` está seteada + su longitud, en **cada** intento de conexión); `src/controllers/authController.js:39-42` (`[LOGIN DEBUG]` — loguea el objeto de error completo en cada login fallido). Ambos marcados en el propio código/`CLAUDE.md` (`### 3`) como "debe removerse".
- **Qué implica**: no expone la contraseña en sí, pero sí usuario+longitud de password y objetos de error completos en logs de producción — exposición de información innecesaria, no un secreto directo.
- **Bloqueado por**: nada — están confirmados como pendientes de borrar hace tiempo, solo falta hacerlo.

### 11. Migración 008 (dashboard snapshots) — estado sin re-verificar
- **Tipo**: dependencia de infraestructura (migración manual).
- **Ubicación**: `src/repositories/dashboardRepo.js`, `src/services/dashboardService.js`.
- **Qué implica**: `getModelPrecisionAvg()` y el resto de trends degradan a `null`/`[]` si `RETSC_LOG_DASHBOARD_SNAPSHOTS` no existe — comportamiento correcto y ya manejado, pero no se reverificó en este escaneo si la migración 008 ya corrió (no era parte del alcance pedido).
- **Bloqueado por**: correr la migración manualmente vía SSMS (fuera de este backend).

### 12. Umbrales de calidad de imagen sin calibrar
- **Tipo**: config hardcodeada, marcada explícitamente como pendiente de calibración.
- **Ubicación**: `src/services/imageValidationService.js` (`QUALITY_THRESHOLDS`), `src/utils/imageQualityAnalyzer.js` (`SAMPLE_STEP`), ambos con comentario `// TODO: calibrar ... con imágenes reales de producto (con María)`.
- **Qué implica**: los umbrales de resolución/nitidez/brillo son valores placeholder hasta que haya volumen real de fotos para calibrar contra.
- **Bloqueado por**: datos reales (esperar volumen de fotos en producción) + confirmación de María — no es puramente código.

### 13. Asimetría de embedding en `buscarSkuPorTexto` (ya documentada, riesgo aceptado)
- **Tipo**: limitación documentada, decisión ya tomada.
- **Ubicación**: `src/services/skuSearchService.js` (comentario de cabecera "ASIMETRÍA CONOCIDA").
- **Qué implica**: el índice se pobló con texto enriquecido (EAN+Producto+Categoría+OCR); la búsqueda solo usa OCR crudo — los scores de coseno pueden salir sistemáticamente más bajos de lo ideal. Ya mitigado vía umbral configurable (`RETSC_CONFIG`).
- **Bloqueado por**: datos reales de uso (ver si el umbral 0.85 necesita ajustarse) — no es un bug, es una decisión ya tomada y documentada.

### 14. Gap de autorización por rol en endpoints "core" — parcialmente cerrado
- **Tipo**: limitación documentada, decisión de producto pendiente.
- **Ubicación**: `docs/TODO-prioridad-3.md` ítem 2; `CLAUDE.md` ítem `### 14`.
- **Qué implica**: `/api/categories` (lectura), `/api/enterprises/me/categories`, `/api/products`, `/api/skus`, `/api/sku-images`, `/api/annotations` (lectura) — cualquier usuario autenticado de una empresa puede llamarlos sin importar su `roleName`. Ya cerrado para `/api/users`/`/api/roles` (era una escalada de privilegios real, corregida).
- **Bloqueado por**: decisión de producto (matriz rol→acción) — explícitamente "no inventar sin el equipo".

### 15. Validación de formato de cédula (Costa Rica) no implementada
- **Tipo**: deuda técnica, propuesta documentada no construida.
- **Ubicación**: `docs/TODO-prioridad-3.md` ítem 1; `CLAUDE.md` ítem `### 13`.
- **Qué implica**: `ced_identidad` solo valida "no vacío" en 3 lugares — no hay checksum ni validación de longitud/formato (a diferencia de `gtinValidator.js`, que sí lo tiene).
- **Bloqueado por**: confirmar si datos legacy en producción ya cumplen las reglas propuestas antes de aplicar validación a escrituras nuevas — decisión de equipo, no puramente técnica.

### 16. Flujo de "usuario fija su propia contraseña" no implementado
- **Tipo**: feature incompleta, propuesta documentada.
- **Ubicación**: `docs/TODO-prioridad-3.md` ítem 3; `CLAUDE.md` ítems `### 1` y `### 15`.
- **Qué implica**: hoy el admin asigna la contraseña directamente al crear un usuario; no hay flujo de email+token de activación. Existe una tabla `RETSC_INF_ACTIVATION_TOKENS` sin ninguna referencia en el código — parece pensada para otro caso de uso (activar admin de empresa nueva, no usuario creado después) y no debe asumirse reutilizable sin confirmar.
- **Bloqueado por**: decisión de equipo (¿reutilizar la tabla o crear una nueva? ¿usuario queda inactivo hasta fijar password? ¿de dónde sale `FRONTEND_URL`?).

### 17. Registro de empresa sin transacción SQL real
- **Tipo**: deuda técnica documentada.
- **Ubicación**: `src/services/enterpriseService.js`; `CLAUDE.md` ítem `### 9`.
- **Qué implica**: `POST /api/enterprises` usa rollbacks compensatorios manuales (borrar fila insertada si un paso posterior falla) en vez de `pool.transaction()` — funciona pero es más frágil ante fallos parciales no previstos.
- **Bloqueado por**: nada — resolvible ya, mismo patrón que `enterpriseCategoryRepo.js`.

### 18. `shelfPhotoQualityService.assessPhoto()` — código muerto
- **Tipo**: stub-incompleto / código muerto.
- **Ubicación**: `src/services/shelfPhotoQualityService.js`; `CLAUDE.md` ítem `### 12`.
- **Qué implica**: documentado en su propio header como el entry point "correcto" para dedup per-enterprise, pero ningún controller/ruta lo llama — solo se usa la variante global.
- **Bloqueado por**: nada — decidir si se cablea (si hace falta un flujo per-enterprise) o se borra.

### 19. Race de concurrencia en provisioning de blob containers
- **Tipo**: deuda técnica, ya mitigada parcialmente.
- **Ubicación**: `src/services/aiInfrastructureService.js:95-101` (try/catch específico para error 2627/2601).
- **Qué implica**: dos categorías/canales provisionando en paralelo con el mismo `container+prefix` pueden chocar contra el UNIQUE constraint — el try/catch ya absorbe este caso específico como "no es un error real", pero el patrón fire-and-forget sin `.catch()` en `categoryService.js` sigue siendo fràgil ante cualquier OTRO error no anticipado.
- **Bloqueado por**: nada — es una mitigación ya aplicada al caso conocido; ampliarla es puro código.

### 20. Nombre de cuenta de storage hardcodeado
- **Tipo**: config hardcodeada.
- **Ubicación**: `src/services/aiInfrastructureService.js:109-110` (`storageAccount: 'storagescopeprod'`), con su propio `// TODO`.
- **Qué implica**: si Railway/otro ambiente usa un storage account distinto de `-prod`, esto queda mal — pero solo afecta metadata/auditoría del container, no la subida real de blobs (ya señalado en la auditoría de Railway de `CLAUDE.md`).
- **Bloqueado por**: nada — extraer del `AZURE_STORAGE_CONNECTION_STRING` en vez de hardcodear.

### 21. Adopción de fotos huérfanas no mueve el blob
- **Tipo**: limitación documentada.
- **Ubicación**: `src/services/skuImageService.js:~386-425`.
- **Qué implica**: al adoptar una imagen huérfana a un SKU real, `image_url` sigue apuntando a `huerfanas/` — funcionalmente correcto pero desprolijo; requiere `blobStorageService.copyBlob()`/`deleteBlob()`, que no existen.
- **Bloqueado por**: nada — requiere escribir 2 funciones nuevas de blob storage, trabajo de código puro, deferido a "una pasada posterior".

### 22. `RETSC_AI_METADATA_DEFINITIONS` sin poblar
- **Tipo**: dependencia de datos de referencia.
- **Ubicación**: `src/repositories/skuFeatureRepo.js`, `src/services/skuImageService.js:107` (mismo TODO en ambos).
- **Qué implica**: `insertMetadata()` no resuelve `metadata_definition_id` porque la tabla de referencia está vacía.
- **Bloqueado por**: poblar esa tabla con las keys oficiales — decisión/tarea de datos, no de lógica.

---

## 🟢 Severidad baja — cosmético o menor

### 23. `findCategoryByName` sin índice / filtra en memoria
- **Ubicación**: `src/services/aiService.js:16` (`// OPTIMIZAR`).
- **Qué implica**: carga todas las categorías y filtra client-side — no escala, pero el volumen actual de categorías es bajo.
- **Bloqueado por**: nada — optimización diferida a cuando la tabla crezca.

### 24. `token` alias legacy en login response
- **Ubicación**: `src/controllers/authController.js`; `CLAUDE.md` ítem `### 2`.
- **Qué implica**: se manda `token` y `accessToken` con el mismo valor, pendiente de que el frontend migre.
- **Bloqueado por**: coordinación con frontend — no depende de este repo.

### 25. Logout stateless (sin revocación real de tokens)
- **Ubicación**: `src/controllers/authController.js`; `CLAUDE.md` ítem `### 4`.
- **Qué implica**: diseño intencional documentado — no es un bug, solo una limitación conocida para cuando se necesite "matar sesión" real.
- **Bloqueado por**: decisión de producto (¿hace falta revocación real?).

### 26. `BATCH_SIZE=64` hardcodeado en `customVisionService.js`
- **Ubicación**: `src/services/customVisionService.js`.
- **Qué implica**: es un límite duro de la API de Custom Vision, no una regla de negocio — hardcodearlo es correcto, no una deuda real, se incluye solo por completitud del escaneo de "números mágicos".
- **Bloqueado por**: N/A — no hace falta cambiarlo.

### 27. `createTag()` sin protección contra nombres duplicados
- **Ubicación**: `src/services/customVisionService.js:261-264` (comentario propio).
- **Qué implica**: llamar `createTag()` (no `ensureTag()`) dos veces con el mismo nombre crea dos tags distintos — riesgo solo si algún código futuro usa `createTag()` en vez de `ensureTag()` (hoy nada lo hace).
- **Bloqueado por**: nada — ya documentado como advertencia para futuros callers.

---

## Resumen ejecutivo

| Severidad | Cantidad |
|---|---|
| 🔴 Alta | 4 |
| 🟡 Media | 18 |
| 🟢 Baja | 5 |
| **Total** | **27** |

**Por bloqueo:**
- **Resolvibles ya (puro código, sin bloqueo externo)**: 12 ítems — #2, #5, #6, #7, #9, #10, #17, #19, #20, #23, #26, #27.
- **Bloqueados por decisión de equipo/producto**: #1, #3, #4, #14, #15, #16, #24, #25.
- **Bloqueados por infraestructura/Azure/migración manual**: #11.
- **Bloqueados por datos/tiempo (calibración, volumen de uso)**: #12, #13, #22.
- **Bloqueados por otro equipo (anotación #42, ya conocido de antes, no repetido en la lista de arriba porque no generó un ítem nuevo en este escaneo)**: mencionado como contexto en varios ítems (#3 de la sesión anterior sigue aplicando: 15 fotos de `category_id=6/OMT` esperando anotación).

## Top de lo que resolver ya (puro código, severidad alta/media, sin bloqueo externo)

1. **#2 — Envolver `setActiveVersion` en `pool.transaction()`** (🔴, resuelve la mitad de la causa raíz del bug de `is_active`).
2. **#5 — Reemplazar el `resolveTagId` viejo de `shelfPhotoUploadService.js` por `ensureTag()`** (🟡, cierra Issue #35 de verdad, no solo a medias).
3. **#6 — Corregir los ~8 comentarios que dicen "migración 006 no aplicada"** (🟡, cero riesgo, evita confusión futura).
4. **#7 — Actualizar/borrar `docs/TODO-menu-roles.md`** (🟡, cero riesgo).
5. **#10 — Borrar los logs `[DB DEBUG]`/`[LOGIN DEBUG]`** (🟡, ya marcados hace tiempo como "borrar después").
6. **#17 — Envolver el registro de empresa en `pool.transaction()`** (🟡).
7. **#20 — Derivar el storage account del connection string en vez de hardcodearlo** (🟡, cosmético pero trivial).

## Lo que depende de terceros (no depende de este trabajo)

- **Decisión de negocio/producto**: matriz de permisos por rol (#14), flujo de set-password (#16), validación de cédula (#15), revocación de sesión (#25), qué hacer con el bug de `is_active` a nivel de constraint (#1, la parte de índice único).
- **Azure/infraestructura**: aplicar migración 008 si no corrió (#11) — el resto de bloqueantes de Azure de sesiones anteriores (Resource ID de predicción, columna VARCHAR) **ya se resolvieron**, no aparecen en este inventario como abiertos.
- **Equipo de anotación (Issue #42, externo)**: las 15 fotos de `category_id=6/canal=OMT` siguen sin cajitas — no es un ítem de este inventario de código, es contexto operativo ya conocido.
- **Frontend**: migración del alias `token`→`accessToken` (#24).
- **Datos/tiempo**: calibración de umbrales de calidad de imagen (#12), ajuste del umbral de `buscarSkuPorTexto` con uso real (#13), poblar `RETSC_AI_METADATA_DEFINITIONS` (#22).

## Hallazgos nuevos (no estaban en la lista de "ítems conocidos" del pedido)

- **#5 — `shelfPhotoUploadService.js` todavía usa `CV_TAG_*`**: corrige/matiza la afirmación de la sesión anterior de que Issue #35 estaba completamente resuelto. Es el hallazgo más importante de este escaneo porque contradice documentación ya escrita.
- **#6 — Comentarios "migración 006 no aplicada" desactualizados**: la migración sí se aplicó esta sesión; el código sigue funcionando (el try/catch no depende del comentario), pero la documentación inline miente sobre el estado real.
- **#7 — `docs/TODO-menu-roles.md` desactualizado**: el trabajo se hizo pero el doc standalone nunca se marcó como resuelto.
- **#4 — Caso borde de cajitas con coordenadas idénticas** (ítem separado del double-submit, aunque relacionado): confirmado como un problema real y no solo teórico, con un mensaje de error confuso para el usuario final.
- **Confirmado CERRADO (ya no es un pendiente)**: las funciones muertas en `productRepo.js` (`findById`/`insert`/`insertMany`/`update` contra columnas GTIN/Enterprise_id inexistentes) que estaban en la lista de "ítems conocidos a confirmar" **ya no existen** — `productRepo.js` hoy solo exporta `listByEnterprise`/`listCategoriesWithProducts`. Se resolvieron en algún momento anterior no documentado explícitamente como tal.
