# Diagnóstico: código actual vs. especificación v1.4 (sección 4 — "de aprobado a modelo publicado")

Fecha: 2026-08-03. Solo diagnóstico — no se tocó código, no se corrieron migraciones, no hay commits.

Archivos revisados: `src/services/annotationSyncService.js`, `src/services/modelTrainingService.js`,
`src/services/modelVersioningService.js`, `src/services/customVisionService.js`,
`src/repositories/aiModelRepo.js`, `src/repositories/trainingPhotoRepo.js`,
`src/repositories/annotationRepo.js`, `migrations/006_add_metrics_to_detection_models.sql`.

## Hallazgo estructural previo (importante para leer todo lo demás)

Hoy coexisten **dos flujos separados y no conectados entre sí** que la spec trata como uno solo:

- **Flujo real de Custom Vision (Issues 8.1/8.2/8.3)**: `annotationSyncService.js` (sync de
  regiones) → `modelTrainingService.js` (disparo manual de training vía
  `POST /api/training/models/:categoryId/train` + polling). Este es el que realmente habla con
  Custom Vision. Termina en `status='TRAINED'` y **nunca publica ni activa nada**.
- **Flujo de versioning/re-entrenamiento (Issue 8.5)**: `modelVersioningService.js`. Gestiona
  `model_version`, `is_active`, aprobación manual (`approved_by`/`approved_at`) y el gate de
  métricas — pero su disparo de entrenamiento (`startRetrain`) está **stubbeado** (comentario
  explícito: `TODO: cuando exista customVisionService.triggerTraining(projectId)`), no llama al
  Custom Vision real. Solo `completeRetrain()` (que en producción nadie llama automáticamente
  hoy) conecta métricas con activación.

Ningún camino end-to-end conecta "training real termina" → "se publica y activa". Esto explica
por qué casi todos los deltas de 4.4 son ❌/⛔.

## Tabla de deltas

| # | Punto de la spec | Estado | Ubicación | Detalle |
|---|---|---|---|---|
| 4.1 | Selección de fotos: `APROBADA` + `cv_sync_status='PENDING'`, batch por query | ⚠️ | `annotationSyncService.js:293-314` (`syncApprovedPhoto`) | No hay ningún `SELECT ... WHERE photo_status='APROBADA' AND cv_sync_status='PENDING'` en el código — el disparo es **evento a evento** (se llama inmediatamente tras aprobar una foto puntual, no por barrido/query batch). Funcionalmente cubre "solo entra lo aprobado", pero no hay una tarea de reconciliación que recoja fotos que quedaron en `PENDING`/`FAILED` sin reintentar (p. ej. si el server se cae a mitad de sync). `cv_sync_status` default es `'PENDING'` al insertar la foto (`trainingPhotoRepo.js:95`), correcto. |
| Arquitectura de tags | 1 modelo por categoría, canal = Tag de la foto completa | ⚠️ | `annotationSyncService.js:60-67` (`resolveTagId`), `customVisionService.js:101-122` (`createImageFromData`) | El tag SÍ se aplica a nivel de imagen completa (correcto, no por cajita) — se pasa como `tagId` en `createImageFromData` al momento de subir la foto (`shelfPhotoUploadService.js`, Etapa 7) y se reutiliza en `createImageRegions`. Pero el tag es un **ID fijo por canal vía env var global** (`CV_TAG_OMT/DTT/CONVENIENCE`), no un tag creado/resuelto por categoría+canal — mismo tag ID para TODAS las categorías del canal. Con más de un proyecto CV activo simultáneo esto es incorrecto (ya documentado como Issue #35 en el propio código). |
| 4.2 (1)(2) | `CreateTag` on-demand por categoría+canal si no existe | ❌ | — | No existe ninguna llamada a `CreateTag` en `customVisionService.js` (grep confirma cero resultados). El servicio no tiene la función implementada; el mapeo tag↔canal es 100% estático vía env vars. |
| 4.2 (3) | Subir imagen + TODAS sus regiones asociadas al tag, batch de 64 | ⚠️ | `customVisionService.js:141-176` (`createImageRegions`) | El batching de 64 SÍ existe, pero solo para **regiones**, no para "imagen + regiones" como una operación combinada de 64 en 64 — la spec describe subir imágenes en lotes de 64; el código sube cada imagen individualmente en el momento del upload de la foto (Etapa 7 de `shelfPhotoUploadService.js`, una llamada por foto), y luego, en sync, batchea solo las regiones de las fotos pendientes. Es una diferencia de diseño (imagen y regiones desacopladas en el tiempo), no necesariamente incorrecta, pero no es lo que describe 4.2 literalmente. |
| 4.2 (4)(5) | Éxito → `SYNCED`; fallo → `ERROR` + `cv_sync_error` + `cv_sync_attempts+1`, sin bloquear batch | ⚠️ | `annotationSyncService.js:106-117` (`markSynced`/`markFailed`), `trainingPhotoRepo.js:217-232` (`updateCvSync`) | La lógica de no bloquear y de incrementar `cv_sync_attempts` (vía `ISNULL(...)+1` en SQL) está bien implementada. **Pero el valor de estado en fallo es `'FAILED'`, no `'ERROR'`** como pide la spec — choque de nombre de valor, no de lógica. Como no hay CHECK constraint documentado sobre `cv_sync_status` (a diferencia de `photo_status`), esto es solo una convención de string, fácil de alinear, pero hoy no coincide. |
| 4.3 | Conteo `SYNCED` por categoría+canal, umbral 15 (primera vez o +15 acumulado) → `TrainProject` automático del proyecto completo | ⛔ | `annotationSyncService.js:263-289` (`checkAndUpdateThreshold`) | Cuenta por `photo_status='APROBADA'` (no por `cv_sync_status='SYNCED'` — delta de criterio, aunque en la práctica casi siempre coincide) y, al llegar al umbral (`SHELF_TRAINING_THRESHOLD`, default 15 — coincide con el número de la spec), **solo marca `status='IMAGES_UPLOADED'`**. No dispara `TrainProject` automáticamente. El entrenamiento real sigue siendo 100% manual vía `POST /api/training/models/:categoryId/train` (`modelTrainingService.js:62-87`), que además exige `status==='IMAGES_UPLOADED'` como guardia. Tampoco hay lógica de "+15 más desde el último entrenamiento" — el estado `SKIP_THRESHOLD_STATUSES` evita re-marcar una vez que salió de `PENDING`/`IMAGES_UPLOADED`, pero no hay un segundo disparo automático tras reentrenar. Choque directo: la spec pide disparo automático, el código requiere intervención humana. |
| 4.4 | Publicación automática al completar training: `PublishIteration`, incrementar `model_version`, swap `is_active`, guardar métricas (monitoreo) | ⛔ / ❌ | `modelTrainingService.js:136-173` (`handleTrainingCompleted`) | Al completar (`status='Completed'` en CV), el código: guarda métricas (si la migración 006 corrió) y llama `aiModelRepo.updateStatus(modelId, 'TRAINED')`. **No hay ningún llamado a `publishIteration`** (no existe la función, solo un TODO comentado en `customVisionService.js:11`), **no incrementa `model_version`**, **no hace swap de `is_active`**. El modelo queda en `TRAINED`, sin activar nunca — la publicación descrita en 4.4 no existe en este flujo. La única forma hoy de llegar a `is_active=1` + `status='READY'` es a través del flujo 8.5 (`modelVersioningService.completeRetrain`/`approveVersion`/`rollback`, vía `aiModelRepo.setActiveVersion`), que es un flujo distinto y no conectado al training real. |
| 4.5 | Métricas solo para monitoreo, no gate; performance por tag en `metrics_json` | ⚠️ (parcial, y con choque en el otro flujo) | `modelTrainingService.js:144-169`; `modelVersioningService.js:45-49,102-126` | En el flujo real (8.3/`modelTrainingService`), las métricas **NO bloquean** — si están por debajo del mínimo solo se loguea un warning y el modelo pasa a `TRAINED` igual. Esto SÍ está alineado con la spec. `metrics_json` guarda el payload crudo de `getIterationPerformance()` (`{ precision, recall, averagePrecision, perTagPerformance, ... }` — la API de CV ya devuelve `perTagPerformance`, así que el dato por tag/canal está disponible, pero nadie lo extrae/expone por separado hoy, solo se serializa el payload entero). **Pero en el flujo paralelo 8.5 (`modelVersioningService.completeRetrain`/`isWorse`), las métricas SÍ son gate**: una versión con `mean_ap` peor que la activa se manda a `AWAITING_APPROVAL` y requiere `approveVersion()` manual — esto es un choque directo con "las métricas NO son gate de publicación", aunque ese flujo específico hoy no está conectado al training real (ver hallazgo estructural). |
| `approved_by`/`approved_at` | La spec dice NO implementar aprobación humana sin confirmar con María | ⛔ (ya implementado) | `migrations/006_add_metrics_to_detection_models.sql` (columnas), `aiModelRepo.js:222-234` (`setApproval`), `modelVersioningService.js:129-149` (`approveVersion`/`rejectVersion`) | Las columnas existen en la migración 006 y el código las usa activamente: `approveVersion(modelId, adminId)` llama `setApproval()` (graba `approved_by`/`approved_at`) y luego activa la versión; `rejectVersion()` también graba aprobación aunque el resultado sea rechazo. Esto es exactamente el mecanismo de aprobación humana que la spec dice no implementar sin confirmar — ya está construido y expuesto (`POST /api/models/:modelId/approve`, `POST /api/models/:modelId/reject`), aunque desconectado del flujo real de training (ver hallazgo estructural). |
| Estados (tabla) | `PENDING → TRAINING → PUBLISHED` únicamente | ⛔ | `aiModelRepo.js:10-14` (comentario de esquema), usos en `modelTrainingService.js` y `modelVersioningService.js` | El código usa un ciclo mucho más largo: `PENDING → PROJECT_CREATED → IMAGES_UPLOADED → TRAINING → TRAINED \| TRAINING_FAILED → READY`, más `AWAITING_APPROVAL \| REJECTED` (8.5) y `ERROR` (fallo de provisioning). La spec no menciona `TRAINED` ni `READY` — probablemente `READY` es conceptualmente lo más cercano a `PUBLISHED` (mismo efecto: `is_active=1`), pero hoy nada en el flujo real de training lo alcanza. `PROJECT_CREATED`/`IMAGES_UPLOADED`/`TRAINING_FAILED`/`AWAITING_APPROVAL`/`REJECTED`/`ERROR` no tienen equivalente en la spec — no está claro si deben colapsarse, mantenerse como sub-estados internos, o eliminarse. |
| Columnas BD | `model_version`, `last_publish_name`, `trained_at`, `precision`/`recall`/`mean_ap`, `metrics_json`, `is_active`, `status` | ⚠️ (mixto) | Ver `aiModelRepo.js:1-24` (comentario de esquema) + migración 006 | `model_version`, `last_publish_name`, `is_active`, `status`, `trained_at` **ya existen en la tabla base** (no vinieron de la migración 006 — confirmado en el comentario de cabecera de `aiModelRepo.js`, que documenta el esquema real vía `INFORMATION_SCHEMA`). La migración 006 agrega `precision_score`/`recall_score`/`mean_ap`/`metrics_json` (nombrados con sufijo `_score` porque `PRECISION` es palabra reservada en T-SQL, y `mean_ap` en vez de `precision`/`recall` "pelados" para las métricas de comparación) — coincide con lo que pide la spec, salvo el naming exacto. **La migración también agrega `approved_by`/`approved_at`, que la spec no pide y de hecho dice no construir sin confirmar.** `last_publish_name` existe en la tabla pero **nada en el código lo escribe** — no hay ningún `UPDATE` que toque esa columna en ningún archivo revisado; está lista para 4.4 pero sin uso. |

## Los 3 choques prioritarios

1. **Estados `TRAINED`/`READY` vs. `PUBLISHED` de la spec.** El código nunca llega a un estado
   equivalente a "publicado automáticamente" desde el flujo real — se detiene en `TRAINED`. Hace
   falta decidir: ¿`READY` se renombra a `PUBLISHED` y se conecta automáticamente al final de
   `handleTrainingCompleted()`? ¿O se introduce `PUBLISHED` como estado nuevo y `READY` queda para
   otra cosa? Esto no es solo un rename — falta la lógica entera de publicación (ver punto 3
   abajo).

2. **Gate de métricas en `modelVersioningService.js` (`isWorse`/`AWAITING_APPROVAL`).** Choca
   directo con "las métricas NO son gate de publicación" de la spec. El flujo real (8.3) no
   gatea, pero este otro flujo (8.5) sí, y ambos coexisten en el código apuntando a la misma
   tabla. Si la spec es la fuente de verdad, este gate debería desactivarse o el flujo 8.5
   completo debería reconsiderarse (¿sigue vivo para re-entrenamientos manuales fuera del ciclo
   automático de la spec, o queda obsoleto?).

3. **`approved_by`/`approved_at` ya implementados y expuestos por API.** No es solo una columna
   sin usar — hay dos endpoints (`POST /api/models/:modelId/approve` y `.../reject`) construidos
   sobre este mecanismo. Si la spec confirma que la publicación es 100% automática sin aprobación
   humana, hay que decidir qué pasa con esos dos endpoints y con el flujo 8.5 completo (¿se
   desactivan? ¿quedan para un caso de uso distinto, como rollback manual, que la spec no cubre
   pero tampoco prohíbe?).

## Qué existe de 4.4 (publicación) y qué falta por completo

**Existe:**
- Columnas en BD: `model_version`, `last_publish_name` (sin usar), `is_active`, `status`.
- Mecanismo de activar/desactivar versión (`aiModelRepo.setActiveVersion`) — dos UPDATEs
  secuenciales, sin transacción (gap ya documentado en el propio código).
- Guardado de métricas (`aiModelRepo.saveMetrics`) — pero atado al flujo 8.5, y en el flujo real
  (8.3) se llama pero sin conectar a activación.

**Falta por completo:**
- `publishIteration()` en `customVisionService.js` — no existe, solo el TODO.
- Cualquier lógica que, al terminar el training real, incremente `model_version`, escriba
  `last_publish_name`, y haga el swap de `is_active` — hoy `handleTrainingCompleted()` termina en
  `updateStatus(modelId, 'TRAINED')` y no llama a nada de `aiModelRepo.setActiveVersion` ni
  equivalente.
- El disparo automático de `TrainProject` al llegar al umbral de 15 (4.3) — sin esto, 4.4 nunca
  se alcanza en producción salvo que un admin dispare el training manualmente.

## Estado de la migración 006

Según el propio código (`modelTrainingService.js:30-38`, `modelVersioningService.js` header,
`aiModelRepo.js` comentarios), la migración 006 fue **verificada como NO aplicada** contra la BD
real (`INFORMATION_SCHEMA`, 2026-07-12). Este diagnóstico no volvió a consultar la BD en vivo —
no se puede confirmar si sigue sin aplicar hoy (2026-08-03) sin acceso directo a
`sqldb-rscope-prod`; el propio CLAUDE.md del repo advierte explícitamente no asumir que corrió
solo porque el código la referencia.

Columnas que trae la migración 006 vs. lo que pide la spec:
- ✅ `precision_score`, `recall_score`, `mean_ap`, `metrics_json` — coinciden conceptualmente
  (nombres con sufijo `_score` por la palabra reservada `PRECISION`, pero mapean 1:1 a lo que la
  spec llama `precision`/`recall`/`mean_ap`).
- ⛔ `approved_by`, `approved_at` — la migración SÍ las trae, y la spec dice explícitamente no
  construir esa lógica sin confirmar. Si se decide eliminar el gate de aprobación humana, estas
  columnas quedarían sin uso (no necesariamente hay que borrarlas de la tabla, pero sí dejar de
  escribirlas).
- `model_version`, `last_publish_name`, `is_active`, `status`, `trained_at` — **no vienen de la
  migración 006**, ya existían en la tabla base. `last_publish_name` en particular está lista y
  sin usar — es la columna que 4.4 necesitaría para `PublishIteration`.

## Preguntas concretas para María

1. **`approved_by`/`approved_at` y los endpoints `/approve`/`/reject`**: ¿se eliminan del flujo
   automático (spec dice publicación 100% automática), o quedan como mecanismo aparte para algo
   que la spec no cubre (p. ej. rollback manual post-publicación, o un caso de re-entrenamiento
   fuera del ciclo de 15 fotos)? Si quedan, ¿bajo qué endpoint/flujo, ya que hoy están atados al
   ciclo 8.5 que no coincide con el ciclo automático de la spec?

2. **Estados `TRAINED`/`READY`**: ¿`READY` se renombra a `PUBLISHED` (mismo significado,
   `is_active=1`), o `PUBLISHED` es un estado nuevo y distinto? ¿Qué pasa con
   `PROJECT_CREATED`/`IMAGES_UPLOADED`/`TRAINING_FAILED`/`AWAITING_APPROVAL`/`REJECTED`/`ERROR` —
   se mantienen como sub-estados internos (útiles para debugging/UI) aunque la spec solo mencione
   3, o se espera que desaparezcan?

3. **`modelVersioningService.js` (Issue 8.5) completo**: ¿sigue vivo para algún caso de uso (p.
   ej. re-entrenamiento manual fuera del disparo automático por umbral), o queda obsoleto una vez
   que 4.3/4.4 se implementen tal como los describe la spec? Esto afecta directamente si hay que
   tocar ese archivo o dejarlo aparte.

4. **Disparo automático de training (4.3)**: ¿reemplaza completamente al endpoint manual
   `POST /api/training/models/:categoryId/train`, o ambos caminos deben coexistir (automático por
   umbral + manual como forzado por un admin)?

5. **`cv_sync_status='ERROR'` vs. `'FAILED'`**: ¿confirma que el valor debe ser literalmente
   `'ERROR'` (como dice la spec) o `'FAILED'` (como está hoy) es aceptable y la spec solo usó un
   nombre genérico? Cambiar el string es trivial pero hay que asegurarse de no romper el filtro
   que usa `annotationSyncService`/frontend si lo consultan.

6. **Migración 006**: ¿confirmado que sigue sin aplicarse en `sqldb-rscope-prod`? Si se decide
   avanzar con el punto 1 (eliminar aprobación humana), ¿se aplica igual con `approved_by`/
   `approved_at` presentes pero sin uso, o se ajusta el script de migración antes de correrlo?

## Recomendación de orden para alinear (una vez validado con María)

1. **Rename/mapeo de estados** (bajo riesgo, mecánico) — una vez resuelta la pregunta 2: mapear
   `READY`→`PUBLISHED` (o introducir `PUBLISHED` nuevo) en `aiModelRepo.js`/
   `modelTrainingService.js`. Cambiar `cv_sync_status` de `'FAILED'` a `'ERROR'` si se confirma
   (pregunta 5).
2. **Lógica nueva — `customVisionService.js`**: implementar `createTag()` (on-demand por
   categoría+canal) y `publishIteration()`. Sin esto, nada de 4.2(1-2) ni 4.4 puede completarse
   sin importar cómo se resuelvan las preguntas de negocio.
3. **Lógica nueva — conectar el ciclo completo**: `checkAndUpdateThreshold` debe pasar de "marcar
   `IMAGES_UPLOADED`" a disparar `TrainProject` automáticamente (4.3), y
   `handleTrainingCompleted()` debe llamar a `publishIteration` + incrementar `model_version` +
   swap de `is_active` (4.4) — sin gate de métricas, solo guardado para monitoreo.
4. **Decisión de negocio pendiente antes de tocar código** (preguntas 1 y 3): qué hacer con
   `modelVersioningService.js`, `approveVersion`/`rejectVersion`, y sus dos endpoints — esto
   determina si ese archivo se elimina, se deja intacto como flujo paralelo, o se fusiona con el
   nuevo flujo automático.
5. **Migración**: confirmar estado real de la 006 contra la BD (pregunta 6) antes de asumir que
   `precision_score`/`recall_score`/`mean_ap`/`metrics_json` están disponibles en producción —
   bloqueante para persistir métricas del nuevo flujo, aunque no bloqueante para la lógica de
   publicación en sí (que no depende de esas columnas).
