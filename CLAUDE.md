# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Code commenting conventions

Every developer (and Claude) **debe comentar activamente el código** siguiendo estas reglas. El objetivo es que cualquier desarrollador pueda escanear el archivo y entender qué está completo, qué es temporal y qué falta.

### Marcadores estandarizados

| Marcador | Cuándo usarlo |
|---|---|
| `// TEMPORAL — <razón>` | Código que funciona pero debe reemplazarse (e.g. workaround de columna faltante en DB, logs de debug) |
| `// TODO: <descripción>` | Funcionalidad incompleta o pendiente de implementar |
| `// OPTIMIZAR: <descripción>` | Código que funciona pero tiene un camino mejor cuando haya tiempo/datos |
| `// NOTA: <descripción>` | Decisión no obvia o invariante que sorprendería a un lector |

### Dónde poner comentarios de bloque (header de archivo)

Cada archivo nuevo debe comenzar con un comentario que explique:
1. Para qué sirve (una línea)
2. Si tiene dependencias externas pendientes (credenciales, columnas de DB, SDKs)
3. TODOs conocidos al momento de crearlo

Ver [src/services/customVisionService.js](src/services/customVisionService.js) y [src/repositories/globalBlobContainerRepo.js](src/repositories/globalBlobContainerRepo.js) como ejemplos del estilo esperado.

### Qué NO comentar

No comentar lo que el nombre del identificador ya dice. El comentario debe explicar el *por qué*, no el *qué*.

---

## Commands

```bash
npm run dev     # Start development server with nodemon (auto-reload)
npm start       # Start production server
npm run backfill:smart-categories -- --dry-run  # List smart categories pending provisioning (no changes)
npm run backfill:smart-categories               # Provision AI infra for all unprovisioned smart categories
node scripts/create-test-data.js   # Generate test Excel and images under test-data/
node scripts/test-sku-images.js    # Integration tests for SKU image module (no HTTP layer)
node scripts/test-annotation-review.js   # Integration tests for annotation approve/correct/reject (hits real DB)
node scripts/test-model-versioning.js    # Integration tests for model retrain/approve/rollback (hits real DB)
node scripts/test-shelf-photo-quality.js # Integration tests for shelf-photo quality gate + dedup (hits real DB)
node scripts/check-connectivity.js       # Read-only diagnostic: pings SQL, blob storage, and other external services
node scripts/cleanup-for-testing.js      # DESTRUCTIVE — wipes all tables except users/enterprises/roles + global-sku-training blobs
node scripts/verify-smart-categories-dedup.js <enterpriseId>  # Read-only: checks for duplicate category/parent names in an enterprise's smart-category listing (Issue B4 regression check)
node scripts/test-user-role-gates.js     # Guard anti-escalada a ADMIN_DTC (userService.assertCanAssignRole); NO toca la BD — stubea repos vía require.cache
node src/utils/gtinValidator.js    # Run inline GTIN self-tests
node src/utils/imageQualityAnalyzer.js   # Run inline image-quality self-tests (sharp-based)
node src/utils/imageQualityValidator.js  # Run inline quality-validator self-tests
node test-db.js                    # Validate Azure SQL connectivity
```

No lint or test commands are configured.

## Environment Setup

Copy `.env.example` to `.env` and fill in values. Required variables:

- `PORT` — server port
- `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER`, `SQL_PASSWORD`, `SQL_PORT` — Azure SQL credentials
- `JWT_SECRET`, `JWT_EXPIRES_IN` — access token signing and expiry (default `30m` — reduced from `1h` per Issue B6/QA session-expiration feedback)
- `JWT_REFRESH_SECRET`, `JWT_REFRESH_EXPIRES_IN` — refresh token signing and expiry (default 30d)
- `BLOB_STORAGE_MODE` — `mock` (default) or `azure`; mock writes to `data/blob-mock/` and serves at `/blob-mock/`
- `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_BLOB_CONTAINER` — required only when `BLOB_STORAGE_MODE=azure`
- `BLOB_MOCK_BASE_PATH` — override mock storage root (default: `data/blob-mock`)
- `BLOB_HIERARCHY_THRESHOLD` — folder-split threshold for blob paths (default: 500)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — email delivery; leave `SMTP_HOST` empty for mock mode (logs to console)
- `AZURE_GLOBAL_TRAINING_CONTAINER` — blob container for AI training images (default: `global-sku-training`); shared by both the category AI infra flow and the SKU image ingestion flow
- `CUSTOM_VISION_TRAINING_KEY`, `CUSTOM_VISION_PREDICTION_KEY`, `CUSTOM_VISION_ENDPOINT`, `CUSTOM_VISION_PREDICTION_RESOURCE_ID` — credenciales de Azure Custom Vision; sin ellas, `customVisionService.js` cae a comportamiento stub en todo el servicio (`isConfigured()` es el gate); con ellas configuradas, todo el servicio hace llamadas HTTP reales — incluido `createImageFromData()` (implementado 2026-07-19, ver más abajo)
- `AZURE_VISION_ENDPOINT`, `AZURE_VISION_KEY` — Azure AI Vision (Image Analysis) credentials for shelf-photo caption/content checks; `azureVisionService.js` stays a permissive stub even when these are set (SDK call not implemented yet)
- `AZURE_GLOBAL_SHELF_CONTAINER` — blob container for shelf-photo training images (default: `global-shelf-training`)
- `AZURE_QUEUE_NAME` — Azure Storage Queue name `queueService.js` posts to after each SKU image upload, for an external `ProcessSkuImageQueue` Azure Function (not in this repo) to consume (default `sku-image-processing`)
- `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_KEY`, `AZURE_SEARCH_INDEX` — reserved for the SKU-image cognitive pipeline (OCR/embeddings search index); not yet wired to any service in this repo
- `SHELF_TRAINING_THRESHOLD` — validated+approved photo count per category/canal that flips a model to `IMAGES_UPLOADED` (default: 15)
- `MODEL_RETRAIN_MIN_PHOTOS` — new validated photos required since last training before retrain is allowed (default: 20)
- `MODEL_METRIC_TOLERANCE` — tolerance when comparing new vs. active model `mean_ap` (default: 0)
- `QUALITY_CAPTION_MIN_CONFIDENCE` — min caption-confidence threshold for shelf photo uploads (default: 0.6; not enforced yet since `azureVisionService.js` is a stub)
- `QUALITY_MIN_WIDTH`, `QUALITY_MIN_HEIGHT` — minimum shelf-photo resolution (default 1280×720)
- `QUALITY_MIN_SHARPNESS`, `QUALITY_SHARPNESS_NORM` — normalized-Laplacian-variance blur threshold and normalization divisor (defaults 0.005 / 100; NOTA in `.env.example` — needs calibration with real shelf photos)
- `QUALITY_MIN_BRIGHTNESS`, `QUALITY_MAX_BRIGHTNESS` — accepted mean brightness range 0–255 (default 30–220)
- `ANNOTATION_VALIDATOR_ROLES` — CSV of roles allowed to approve/correct/reject shelf-photo annotations (default `ADMIN,ADMIN_DTC`)
- `SHELF_UPLOAD_ROLES` — CSV of roles allowed to upload shelf photos (default `ADMIN,ADMIN_DTC`)
- `MODEL_MANAGER_ROLES` — CSV of roles allowed to retrain/approve/reject/rollback AI detection models (default `ADMIN,ADMIN_DTC`)
- `CV_TAG_OMT`, `CV_TAG_DTT`, `CV_TAG_CONVENIENCE` — Custom Vision tag IDs per canal; TODO — replace with a DB-backed tag lookup (Issue #35)
- `TRAINING_ADMIN_ROLES` — CSV de roles autorizados a disparar entrenamiento vía `/api/training` (default `ADMIN,ADMIN_DTC`)

## API docs (Swagger)

`GET /api/docs` sirve Swagger UI generado por `swagger-jsdoc` desde comentarios `@swagger` puestos arriba de cada ruta en `src/routes/*.js` (config en `src/config/swagger.js`) — no hay `openapi.yaml` a mano, así se documenta al lado del código real. **Solo se monta si `NODE_ENV !== 'production'`** (`src/app.js`) — en producción la ruta no existe en absoluto. Documentadas como muestra (2026-07-20): `POST /api/auth/login`, `GET /api/roles`, `GET /api/products` (con el footgun de `categoryId` explícito en la descripción del parámetro). El resto de los 15+ endpoints queda pendiente — copiar el patrón documentado en el header de `src/config/swagger.js`, revisando primero cuál de los 3 patrones de montaje de auth aplica a esa ruta (ver sección "Middleware mounting pattern" más abajo).

## Deployment readiness (Railway, auditoría 2026-07-23)

Auditoría de solo-lectura (sin cambios de código) para evaluar qué falta antes de desplegar en Railway. Hallazgos:

- `server.js` lee `PORT` correctamente (`process.env.PORT || 3000`) — Railway puede asignar su propio puerto sin fricción.
- **Dos riesgos silenciosos** (la app arranca y responde normal, pero falla mal solo en runtime):
  - `BLOB_STORAGE_MODE` — default `mock`. Si se olvida poner `azure` explícitamente en las env vars de Railway, la app escribe imágenes en disco local; ese disco es efímero en Railway y las imágenes se pierden en cada redeploy/restart, sin ningún error visible hasta que alguien note que "desaparecieron".
  - `NODE_ENV` — si no se setea a `production`, el gate de `/api/docs` (ver sección Swagger arriba) lo deja expuesto por defecto.
- **6 env vars son bloqueantes reales** si faltan (rompen en el primer request que las use, no al bootear): `SQL_SERVER`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DATABASE`, `JWT_SECRET`, `JWT_REFRESH_SECRET` — ninguna tiene default en el código.
- **Hardcodes encontrados** (no bloqueantes, pero a revisar si Railway usa recursos distintos a los de `-prod`): `aiInfrastructureService.js` tiene `storageAccount: 'storagescopeprod'` hardcodeado (ya tenía su propio TODO previo — de fallar, solo afecta metadata/auditoría del container, no la subida real de blobs); `src/config/swagger.js` tiene `http://localhost:3032` como único `server` de la spec (cosmético, Swagger ya está gateado fuera de prod).
- **Checklist manual** (no verificable desde el código, requiere acceso a Azure/Railway): firewall de Azure SQL debe permitir las IPs de salida de Railway; red hacia Blob Storage y Custom Vision sin restricciones que bloqueen a Railway; confirmar que la base de destino tiene aplicadas **todas** las migraciones (`001`–`006`), no solo la 006; el polling de training en memoria (Issue 8.3, ver sección de entrenamiento más abajo) se pierde si Railway reinicia el contenedor mientras un modelo está en `TRAINING` — más probable en un ambiente con redeploys frecuentes que en producción estable.
- **Migración 006 — re-confirmada como NO aplicada** (2026-07-23) contra `sqldb-rscope-prod`, la única base accesible desde el `.env` de este repo — mismo hallazgo que ya documentaba la sección de entrenamiento más abajo, ahora reverificado específicamente para esta auditoría. No se aplicó nada — pendiente de decisión de equipo sobre si Railway apunta a esta misma base o a una distinta que Carlos gestiona por separado.

## Architecture

Express layered architecture. All persistence is **Azure SQL (MSSQL)** via a single lazy-initialized connection pool in `src/config/db.js`.

```
server.js                     Entry point
src/app.js                    CORS, body parsing, route mounting, 404/error handlers
src/routes/                   Route definitions
src/controllers/              Input validation, calls services, formats HTTP responses
src/services/                 Business logic
src/repositories/             Data access — all SQL reads/writes go here
src/middlewares/authMiddleware.js   JWT verification; attaches decoded payload to req.user
src/middlewares/requireAdmin.js    Legacy wrapper — now literally requireRole(ROLES.ADMIN, ROLES.ADMIN_DTC), kept as its own file so existing routes importing it don't all need touching at once
src/middlewares/requireRole.js     Parameterized role check; requireRole(...roles) 403s unless req.user.roleName (normalized via normalizeRole — trim+uppercase) is in the list
src/config/roles.js                Canonical role catalog (ROLES.{ADMIN,ADMIN_DTC,EJECUTIVO_CAMPO,GERENCIA,AUDITOR_CAMPO}) + normalizeRole(); all role comparisons must go through this, never a literal string or Role_id (Role_id varies between environments — prod 1-5, QA 1,4,7,8,9)
src/config/db.js              MSSQL connection pool (max 10, lazy init on first getPool() call)
src/utils/gtinValidator.js              EAN8/UPC12/EAN13 check-digit validation
src/utils/imageHasher.js               SHA-256 hashing for dedup
src/utils/validators.js                Shared input validators (isValidEmail)
src/utils/mailer.js                    Email delivery via nodemailer; mock mode when SMTP_HOST is unset
src/utils/categoryNameNormalizer.js    Slug generator used by both AI infra and SKU image blob paths
src/utils/skuImageFilenameParser.js    Parses `{EAN}_{view}.{ext}` filenames; returns null on invalid names
src/utils/skuImageFilenameGenerator.js Generates canonical blob filenames from { ean, view, ext }
src/utils/shelfPhotoFilenameGenerator.js Generates collision-proof shelf-photo blob filenames ({slug}-{CANAL}-{timestamp}-{uuid8}.jpg)
src/utils/imageQualityAnalyzer.js      sharp-based pixel analysis: resolution, brightness, Laplacian-variance sharpness
src/utils/imageQualityValidator.js     Wraps imageQualityAnalyzer with pass/fail thresholds + error codes (used by shelf-photo quality gate)
data/blob-mock/                        Local mock blob storage, served as static files
uploads-temp/                          Temporary files during pipeline runs; auto-cleaned after job
docs/                                   Bugs/decisiones documentadas fuera del código (ver docs/BUG-is_active-no-unico.md)
```

`requireAdmin.js` is now a thin wrapper over `requireRole.js` (`requireRole(ROLES.ADMIN, ROLES.ADMIN_DTC)`) — it used to be a separate hardcoded `roleName === 'Admin'` check, but that broke completely when roles were renamed to uppercase (see role system section below) and was fixed by delegating to `requireRole`'s normalized comparison. `ADMIN_DTC` (the DTC superuser) can always do anything `ADMIN` can. Newer route groups (shelf-photos, annotations, models, training) call `requireRole` directly with roles read from CSV env vars; older ones (enterprises, roles endpoints) still import `requireAdmin`, which is equivalent.

### Role system (Issues B1–B4, feedback de la dueña del proyecto, 2026-07-01)

Roles were renamed to **uppercase** in the DB (`scripts/sync-roles-with-qa.js`) and the legacy `Analista`/`Supervisor` roles were removed (`scripts/remove-legacy-roles.js`) — see `docs/TODO-menu-roles.md` and `docs/TODO-prioridad-3.md` for the full history. `src/config/roles.js` is now the single source of truth: `ROLES.{ADMIN, ADMIN_DTC, EJECUTIVO_CAMPO, GERENCIA, AUDITOR_CAMPO}` (values match `Role_name` exactly, e.g. `'EJECUTIVO CAMPO'` with a space) plus `normalizeRole()` (trim + uppercase), used on **both sides** of every role comparison in the codebase — `roleRepo.findByName()` also does a case-insensitive `UPPER()` SQL comparison for the same reason. Never compare against a literal string or against `Role_id` (it varies between environments: prod 1–5, QA 1,4,7,8,9).

`ADMIN_DTC` is a DTC-wide superuser, distinct from a per-enterprise `ADMIN`:
- `GET/GET-list /api/enterprises` — `ADMIN_DTC` sees every enterprise; a plain `ADMIN` only ever sees their own (`req.user.enterpriseId`), not the result of a "find enterprises I'm linked to" query. `enterpriseService.listByUser()` was removed for this reason.
- `GET/PUT /api/enterprises/:id` — 403 for a plain `ADMIN` if `:id` doesn't match their own `enterpriseId`; `ADMIN_DTC` can access any.
- `POST /api/enterprises/create` (creating a new client enterprise) is restricted to `ADMIN_DTC` via `requireRole` at the route level.
- Taxonomy/category-tree management (`/api/categories` write routes) is exclusive to `ADMIN_DTC` (Issue B4).
- `/api/users` (all routes) and `/api/roles` (write routes — `POST`/`PUT`/`PATCH`) are `ADMIN_DTC`-or-`ADMIN`/`ADMIN_DTC`-only respectively (audit 2026-07-25, see Pending Work #14 below).
- **Invariant: `ADMIN_DTC` can only be granted by another `ADMIN_DTC`.** `requireAdmin`/`requireRole(ROLES.ADMIN, ROLES.ADMIN_DTC)` treats `ADMIN` and `ADMIN_DTC` as equally privileged for *route access*, but a plain `ADMIN` must never be able to *assign* the `ADMIN_DTC` role to a user — that would let any per-enterprise admin mint themselves (or anyone) a platform-wide superuser. Enforced in `userService.js` via `assertCanAssignRole(role, actorRoleName)`, called from both `createAndAssign()` and `updateUserEnterprise()` right after the target role is looked up. Fails closed: if a callsite forgets to pass `actorRoleName`, `normalizeRole(undefined)` is `''`, which never matches `ROLES.ADMIN_DTC`, so the assignment is rejected rather than silently allowed.

`src/repositories/jsonRepo.js` is dead code — it exists but no repository imports it. All real persistence uses MSSQL.

### Menú por rol (F4, confirmado por María 2026-07-25)

Tres menús **web**: `ADMIN_DTC`, `ADMIN`, `GERENCIA`. `EJECUTIVO CAMPO` y `AUDITOR CAMPO` **no tienen menú web** — son roles exclusivos de la app móvil.

**El bloqueo de `EJECUTIVO CAMPO`/`AUDITOR CAMPO` fuera del menú web vive ÚNICAMENTE en el frontend web, nunca en este backend.** `POST /api/auth/login` sigue sin tocarse y sigue emitiendo el mismo JWT para los 5 roles — la app móvil comparte el mismo backend, el mismo login y esos mismos roles, así que bloquearlos acá adentro rompería la app móvil. Esto es lo primero que alguien va a querer "arreglar" en el backend pensando que es un descuido de seguridad — no lo es, es la razón de diseño de por qué este backend no gatea `login` por rol.

Ítems del menú nuevo que necesitaron endpoints que no existían (2026-07-25/26):
- **Modelos de detección** (`ADMIN_DTC`) → `GET /api/models`
- **Anotaciones** (`ADMIN_DTC`) / **Revisar cajitas** (`ADMIN`) → `GET /api/annotations/photos`, `GET /api/annotations/photos/:photoId`, `PATCH /api/annotations/photos/:photoId/approve` (activó código muerto del Issue 8.2 — ver esa sección)
- **Usuarios globales** (`ADMIN_DTC`) → `GET /api/users/global`
- **SKUs globales** (`ADMIN_DTC`) → `GET /api/skus/global`
- **Productos** (`ADMIN_DTC`) → `GET /api/products/global` — catálogo global derivado de `RETSC_OP_SKUS` (agrupado por `Product_dsc` + `detection_category_id`), **no** de una tabla `RETSC_OP_PRODUCTS` (eliminada, commit `b775f86`); distinto de "SKUs globales", que lista una fila por EAN sin agrupar. Ver `PRODUCT_GROUP_KEY_EXPR` en `skuRepo.js` para el criterio de agrupación y por qué no hay una FK que lo dicte.

Todo lo demás del menú se resolvió con endpoints que ya existían. Explícitamente **fuera de alcance** (sin tabla/datos en la BD para soportarlo, implementado como "Pronto" en el frontend sin backend): Tiendas activas, Planogramas (no hay tabla de retailers — `RETSC_EX_SHELFPHOTO.Retailer_id` es solo una columna suelta sin catálogo detrás), y todo el bloque operativo de `GERENCIA` (Visitas, KPIs de cumplimiento, Faltantes detectados, Reportes por tienda/producto/ejecutivo, Ejecutivos de campo). No inventar tablas/migraciones/endpoints para esto sin que el equipo lo pida explícitamente.

### Shelf photo annotation & model training pipeline (Issues 3.1.1 follow-on, 8.5, 42)

Distinct from the SKU-level AI infra above, this pipeline trains **object-detection models on shelf/gondola photos** for smart-DTC categories:

```
POST /api/shelf-photos/upload  (shelfPhotoUploadService.uploadShelfPhoto)
  1. validate canal (OMT|DTT|CONVENIENCE) + category is_smart_dtc=1
  2. shelfPhotoQualityService.validateQualityMetrics()  → resolution/blur/brightness (sharp)
  3. azureVisionService.analyzeCaption() + isShelf()     → STUB, always permissive
  4. dedup via SHA-256 (shelfPhotoRepo.findByHashGlobal, global scope, enterprise_id=NULL)
  5. blobStorageService.uploadToContainer()              → global-shelf-training/dtc-{slug}/{canal}/
  6. customVisionService.createImageFromData()           → cvImageId real (implemented — see Custom Vision section below)
  7. annotationRepo.insert()                              → RETSC_AI_TRAINING_ANNOTATIONS (unvalidated)
  8. threshold check → aiModelRepo.updateStatus(..., 'IMAGES_UPLOADED') when SHELF_TRAINING_THRESHOLD reached

Annotation review (/api/annotations)     — human validates/corrects/rejects bounding boxes
  └─► #54 (external, not in this repo) sets photo_approved=1/rejects
        └─► annotationSyncService.syncApprovedPhoto()/removeRejectedPhoto()  → pushes regions to Custom Vision
  └─► modelVersioningService (/api/models) — retrain/compare-metrics/approve/reject/rollback versions
  └─► POST /api/training/models/:categoryId/train (modelTrainingService) → trains + polls Custom Vision in background
```

Key files: `src/services/shelfPhotoUploadService.js` (orchestrator), `src/services/shelfPhotoQualityService.js` (pixel quality gate, mirrors `imageValidationService.js` used by the SKU pipeline), `src/services/azureVisionService.js` (stub — see below), `src/services/annotationService.js` + `src/repositories/annotationRepo.js`, `src/services/annotationSyncService.js` (Custom Vision region sync, Issue 8.2 — see below), `src/services/modelVersioningService.js`, `src/services/modelTrainingService.js` (Custom Vision training + polling, Issue 8.3 — see below).

`src/services/azureVisionService.js` is a **stub**: `isConfigured()` checks `AZURE_VISION_ENDPOINT`/`AZURE_VISION_KEY`, but `analyzeCaption()` and `isShelf()` always return permissive stub results regardless — the real SDK (`@azure-rest/ai-vision-image-analysis`) is not installed yet, only TODO'd.

`RETSC_AI_TRAINING_ANNOTATIONS` columns: `annotation_id` (PK), `photo_id`, `dtc_category_id`, `bbox_left/top/width/height` (float, normalized 0–1), `source`, `is_validated` (bit), `photo_approved` (bit), `photo_notes`, `photo_reviewed_at`, `photo_reviewer_id`, `cv_region_id`, `canal` (`OMT`|`DTT`|`CONVENIENCE`, NOT NULL), plus `blob_path`, `cv_sync_status`, `cv_sync_error`, `cv_sync_attempts` (present in the real table, not originally in this header — see annotationRepo.js). A photo cannot be left with zero annotations — `annotationService.reject()` returns 409 if it's the last one for that photo. `annotationRepo.approvePhoto()` (bulk-approve all annotations for a photo) and `listPhotos()`/`getPhotoWithRegions()` are **wired** as of 2026-07-25 (menú por rol, see Pending Work #10 below) — no longer dead code.

`RETSC_EX_SHELFPHOTO` gained quality/dedup columns via migration 005 (`image_hash`, `quality_status`, `quality_error_code`, `width`, `height`, `blur_score`, `brightness`); unique filtered index on `(ENTERPRISE_ID, image_hash)`.

`RETSC_AI_DETECTION_MODELS` gained versioning columns via migration 006 (`precision_score`, `recall_score`, `mean_ap`, `metrics_json`, `approved_by`, `approved_at`). `modelVersioningService.js` manages the retrain lifecycle on top of the same table `aiInfrastructureService.js` initially provisions: retrain requires ≥`MODEL_RETRAIN_MIN_PHOTOS` (default 20) new validated photos since the active version's `trained_at`; a new version whose `mean_ap` is worse than the active one goes to `AWAITING_APPROVAL` instead of auto-activating; rollback reactivates a prior (never-deleted) version.

Role gates (CSV env vars, all default to `ADMIN,ADMIN_DTC`): `ANNOTATION_VALIDATOR_ROLES` for approve/correct/reject, `SHELF_UPLOAD_ROLES` for photo upload, `MODEL_MANAGER_ROLES` for all `/api/models` routes, `TRAINING_ADMIN_ROLES` for `/api/training`.

### Sincronización de anotaciones a Custom Vision (Issue 8.2)

`src/services/annotationSyncService.js` **no expone ruta HTTP propia**: es la interfaz acordada con el disparador de aprobación del cliente (Issue #54, construido por otra persona, todavía no integrado en este repo). Dos puntos de entrada:

- **`syncApprovedPhoto(photoId, { clienteAjustoCajitas })`** — se debe llamar inmediatamente después de que algo setee `photo_approved=1`. Si `clienteAjustoCajitas === false` no se toca Custom Vision (las cajitas ya estaban sincronizadas de una corrección previa); en cualquier otro caso se borran las regiones viejas y se recrean todas las cajitas actuales de la foto. Luego siempre corre `checkAndUpdateThreshold`. **Desde 2026-07-25 tiene DOS disparadores**: el Issue #54 original (externo, sigue sin integrarse) y `PATCH /api/annotations/photos/:photoId/approve` (menú por rol, Pending Work #10). Si #54 se integra más adelante, decidir cuál de los dos llama a `syncApprovedPhoto` para la misma foto — no debería ser ambos. No es urgente: `syncRegionsForPhoto` ya es idempotente por `cv_region_id` (`splitByCvRegionId`), así que una doble llamada no duplica regiones en Custom Vision, solo generaría llamadas HTTP redundantes.
- **`removeRejectedPhoto(photoId)`** — borra las regiones (y la imagen) en Custom Vision pero **conserva la fila en SQL** — el issue pide no borrar registros.

Ninguna de las dos lanza por fallos de Custom Vision — la aprobación/rechazo ya quedó persistida en SQL antes de llamarlas y no debe revertirse por un problema de sincronización; los fallos se registran en `cv_sync_status='FAILED'` / `cv_sync_error` / `cv_sync_attempts` (columnas ya presentes en `RETSC_AI_TRAINING_ANNOTATIONS`) para reintento manual.

Dos decisiones no obvias documentadas en el header del archivo:
- El `cvImageId` de una foto viaja embebido en el texto libre `photo_notes` (formato `"blob:... | sha256:... | cvImageId:..."`, escrito por `shelfPhotoUploadService`) — **no tiene columna propia** (TEMPORAL).
- Custom Vision no devuelve un ID de correlación al crear regiones y **no preserva el orden de envío** — `createImageRegions()` se correlaciona por coordenadas (`coordsMatch()`, tolerancia `1e-6`). Dos cajitas con coordenadas idénticas en la misma foto hacen que Custom Vision rechace el batch entero (`400 Duplicate image regions`), lo que marca **todas** las anotaciones de esa foto como `FAILED`, no solo las duplicadas.

⚠ **Bug conocido sin corregir** (`docs/BUG-is_active-no-unico.md`): nada en la BD impide más de una fila `is_active=1` para la misma `category_id` en `RETSC_AI_DETECTION_MODELS` — no hay constraint ni índice único filtrado. `aiModelRepo.findByCategoryId()` (usado por `annotationSyncService`, `modelVersioningService.setActiveVersion()` y `shelfPhotoUploadService`) simplemente toma `recordset[0]` si eso llega a pasar, sin garantía de cuál fila devuelve. Ya causó un incidente real en pruebas contra producción (`category_id=36`). La corrección requiere decisión de equipo (índice único filtrado vs. transacción explícita) — no se resuelve implícitamente al tocar código relacionado.

### Entrenamiento de modelos (`/api/training`, Issue 8.3)

`POST /api/training/models/:categoryId/train` (montada con `authMiddleware` + `requireRole(TRAINING_ADMIN_ROLES)`, default `Admin`) dispara el entrenamiento en Custom Vision para el modelo activo de una categoría. Solo válido si `status='IMAGES_UPLOADED'` (409 en cualquier otro estado) y el modelo tiene `customvision_project_id`.

`modelTrainingService.startTraining()` es fire-and-forget: llama a `customVisionService.trainProject()`, marca `status='TRAINING'`, responde `202` de inmediato, y lanza `pollTrainingStatus()` **sin await** en background dentro del mismo proceso Node (consulta cada 30s, hasta 40 intentos = 20 min de timeout de seguridad, se rinde tras 3 fallos de red consecutivos). El progreso se consulta con `GET /api/models/category/:categoryId` (ya existente, Issue 8.5).

**Limitación conocida**: el polling vive en memoria del proceso — si el server se reinicia a mitad de un entrenamiento, el polling se pierde y el modelo queda "colgado" en `TRAINING` (Custom Vision sigue entrenando del lado de Azure, pero nadie vuelve a consultarlo). No hay lógica de reanudación al arrancar (a diferencia de `jobRepo.failStaleRunning` en `app.js`) — TODO fuera de alcance del Issue 8.3.

Al completar (`status Completed` en Custom Vision), métricas por debajo del mínimo recomendado (`precision<0.80`, `recall<0.75`, `mAP<0.75`) **no bloquean** el paso a `TRAINED` — solo se loguean como advertencia; decidir si son aceptables es responsabilidad del admin (o del futuro flujo de publicación, Issue 8.4), no de este servicio.

⚠ **Migración 006 verificada como NO aplicada en la BD real** (confirmado con `INFORMATION_SCHEMA`, 2026-07-12) — pese a que `aiModelRepo.js` (Issue 8.5) ya asume que las columnas `precision_score`/`recall_score`/`mean_ap`/`metrics_json` existen. `aiModelRepo.saveMetrics()` lanza `"Invalid column name"` hasta que se corra esa migración manualmente. `handleTrainingCompleted()` envuelve ese llamado en try/catch para que un fallo de guardado de métricas nunca impida pasar a `TRAINED` — las métricas quedan logueadas mientras tanto. No confiar en que la migración 006 ya está aplicada solo porque el código la asume.

### Smart category AI infrastructure (Issue 3.1.1)

When a category is created or updated with `is_smart_dtc=1`, the system automatically provisions AI infrastructure in background (fire-and-forget, does not block the HTTP response):

```
categoryService.createCategory()
  └─► aiInfrastructureService.provisionForCategory()   [background]
        ├─► blobStorageService.createMarker()           → global-sku-training/dtc-{slug}/.keep
        ├─► globalBlobContainerRepo.insert()            → RETSC_INF_GLOBAL_BLOB_CONTAINERS
        ├─► aiModelRepo.insert()                        → RETSC_AI_DETECTION_MODELS (status=PENDING)
        └─► customVisionService.createProject()         → proyecto real si hay credenciales; null si no
```

Key files:
- `src/utils/categoryNameNormalizer.js` — slug generator for blob prefix names (e.g. `"Vino Tinto"` → `"vino-tinto"`)
- `src/services/aiInfrastructureService.js` — orchestrator; never throws, returns `{ status, errors[] }`
- `src/services/customVisionService.js` — **ya no es un stub** (Issue 8.1/8.2/8.3, cerrado 2026-07-19): `createProject()`, `createImageFromData()`, `createImageRegions()`, `deleteImageRegion()`, `deleteImages()`, `trainProject()`, `getIteration()`, `getIterationPerformance()` hacen llamadas HTTP reales a la API v3.3 de Custom Vision Training usando `fetch` nativo (no el SDK oficial — la key de Azure AI Services unificada trae caracteres no-ASCII que el módulo `http` de Node rechaza en headers pero `fetch` acepta). `isConfigured()` sigue siendo el gate para todo el servicio.
- `src/repositories/globalBlobContainerRepo.js` — wraps `RETSC_INF_GLOBAL_BLOB_CONTAINERS`; prefix stored in `description` field (TEMPORAL, see pending #7)

Blob prefix format: `dtc-{slug}` inside the `AZURE_GLOBAL_TRAINING_CONTAINER` container (default: `global-sku-training`). The `.keep` marker file makes the prefix visible in the Azure Portal as a folder.

### Database tables

Each file in `src/repositories/` maps to one SQL table:

| Repository | Table |
|---|---|
| `userRepo.js` | `RETSC_OP_USERS` |
| `enterpriseRepo.js` | `RETSC_OP_ENTERPRISE` |
| `userEnterpriseRepo.js` | `RETSC_OP_USRSXENTERP` |
| `roleRepo.js` | `RETSC_OP_ROLES` |
| `categoryRepo.js` | `RETSC_OP_CATEGORIES` |
| `enterpriseCategoryRepo.js` | `RETSC_OP_ENTERPRISE_CATEGORIES` |
| `productRepo.js` | `RETSC_OP_ENTERPRISE_PRODUCT_SEG` + `RETSC_OP_SKUS` (read-only listings) |
| `imageRepo.js` | `RETSC_LOG_IMAGE_UPLOAD` |
| `loadStateRepo.js` | `RETSC_LOG_SKU_UPLOAD` (⚠ broken — see below) |
| `skuRepo.js` | `RETSC_OP_SKUS`, `RETSC_OP_ENTERPRISE_PRODUCT_SEG`, `RETSC_LOG_SKU_UPLOAD` |
| `aiModelRepo.js` | `RETSC_AI_DETECTION_MODELS` |
| `skuFeatureRepo.js` | `RETSC_AI_SKU_FEATURES` + `RETSC_AI_SKU_IMAGE_METADATA` |
| `skuImageLogRepo.js` | `RETSC_LOG_IMAGE_UPLOAD` (shared with `imageRepo.js`, different columns) |
| `jobRepo.js` | `RETSC_LOG_JOBS` |
| `shelfPhotoRepo.js` | `RETSC_EX_SHELFPHOTO` |
| `annotationRepo.js` | `RETSC_AI_TRAINING_ANNOTATIONS` |

`userEnterpriseRepo.js` gained `findAllGlobal()` (2026-07-25, F4 menu) — a single JOIN across `RETSC_OP_USRSXENTERP` + `RETSC_OP_USERS` + `RETSC_OP_ROLES` + `RETSC_OP_ENTERPRISE`, used by `userService.listAllGlobal()` (`GET /api/users/global`). Deliberately different from `listByEnterprise`'s N+1 pattern (a `findById` for the user and another for the role per relation) — at global/cross-enterprise scale that N+1 gets expensive fast, and the JOIN's fixed shape (user + role + enterprise, no per-row conditional logic) doesn't need the loop. `listByEnterprise` itself was left as-is (out of scope for this change).

`skuRepo.js` gained `listGlobal(filters)` (2026-07-25, F4 menu) — paginated (`OFFSET`/`FETCH` + `COUNT(*)`) global listing over `RETSC_OP_SKUS`, search by `EAN`/`Product_dsc`, same `buildFilters`-style pattern as `productRepo.listByEnterprise`. Deliberately does **not** JOIN to `RETSC_OP_CATEGORIES` to resolve category names: `selected_category_id` on `RETSC_OP_SKUS` is an FK to `RETSC_OP_ENTERPRISE_CATEGORIES.enterprise_category_id`, not to `RETSC_OP_CATEGORIES.Category_id` (see the SKU ingestion flow section above) — joining it directly against `RETSC_OP_CATEGORIES` would silently show the wrong category description most of the time. Only `detection_category_id` maps directly to `RETSC_OP_CATEGORIES.Category_id`, but it's returned unresolved too, to avoid mixing a correct join with an incorrect one in the same row — the frontend can resolve both IDs via the existing category endpoints if it needs display names.

`skuRepo.js` also gained `listGlobalProducts(filters)` (2026-07-26, F4 menu item "Productos", `GET /api/products/global`) — same paginated pattern, but `GROUP BY` over `RETSC_OP_SKUS` instead of one row per SKU. **There is no FK that defines "product" separately from "SKU"** — `RETSC_OP_PRODUCTS` was dropped (commit `b775f86`) and today one `RETSC_OP_SKUS` row is one EAN. Leadership still wants "Productos" to be a distinct view from "SKUs globales" (one row per EAN, unaggregated), so the grouping key chosen is `(Product_dsc, detection_category_id)` — two EANs with the exact same description **and** the same global/smart category collapse into one product row (e.g. a repackaging that reissues the EAN but keeps the name); same description under a *different* category does not collapse (avoids merging two unrelated products that happen to share descriptive text). Verified against real data (2026-07-26, 3 SKUs, each with a distinct `Product_dsc`) that this grouping doesn't collapse anything yet — the criterion is in place for when duplicate EANs-under-one-name actually occur. `Product_dsc` is nullable in the real schema (though no row is `NULL` today) — grouping directly on it would silently merge every `NULL`-description SKU into one fake product, so the actual `GROUP BY` expression (`PRODUCT_GROUP_KEY_EXPR`) falls back to the SKU's own `SKU_ID` when `Product_dsc IS NULL`, keeping each description-less SKU in its own group. The view never selects any `RETSC_OP_ENTERPRISE_PRODUCT_SEG` column (brand/supplier/client category) — that's what makes it "global"/client-free, unlike `GET /api/products`.

`RETSC_LOG_JOBS` (migration `004_create_jobs_table.sql`) tracks generic async batch jobs — currently only `job_type='SKU_IMAGE_UPLOAD'`. Columns: `job_id` (PK), `user_id`, `enterprise_id`, `job_type`, `status` (`QUEUED → RUNNING → COMPLETED|FAILED`), `total_files`, `processed_count`, `orphan_count`, `duplicate_count`, `error_count`, `warning_count`, `error_summary`, `created_at`, `started_at`, `finished_at`. On server boot, `app.js` calls `jobRepo.failStaleRunning(...)` to mark any job left `RUNNING` from a crash/restart as `FAILED`.

`RETSC_EX_SHELFPHOTO` base columns: `Photo_id` (PK), `Retailer_id`, `Shelfunit_id`, `photo_date`, `URL_blob`, `ENTERPRISE_ID`, `CATEGORY_ID`, `visit_id`. Migration `005_add_quality_fields_to_shelfphoto.sql` adds `image_hash`, `quality_status` (`PASSED`/`REJECTED`), `quality_error_code`, `width`, `height`, `blur_score`, `brightness`, plus a filtered unique index `UX_RETSC_EX_SHELFPHOTO_enterprise_hash` on `(ENTERPRISE_ID, image_hash) WHERE image_hash IS NOT NULL` for per-enterprise dedup. This migration must be applied manually via SSMS, not from Node.

`RETSC_AI_TRAINING_ANNOTATIONS` columns: `annotation_id` (PK), `photo_id`, `dtc_category_id`, `bbox_left`, `bbox_top`, `bbox_width`, `bbox_height` (floats normalized to `[0,1]`), `source`, `is_validated` (bit), `created_at`, `photo_approved` (bit), `photo_notes`, `photo_reviewed_at`, `photo_reviewer_id`, `cv_region_id`, `canal` (NOT NULL).

`RETSC_AI_DETECTION_MODELS` (extended by migration `006_add_metrics_to_detection_models.sql`) adds versioning columns: `precision_score`, `recall_score`, `mean_ap` (primary comparison metric — named `*_score`/`mean_ap` instead of `precision`/`recall` because `PRECISION` is a T-SQL reserved word), `metrics_json` (raw Custom Vision iteration payload), `approved_by`, `approved_at`, plus index `IX_RETSC_AI_DETECTION_MODELS_category_version (category_id, model_version DESC)`. ⚠ Esta migración fue verificada como **NO aplicada** contra la BD real de este proyecto (`INFORMATION_SCHEMA`, 2026-07-12) — ver nota en la sección de entrenamiento más abajo; no asumir que corrió solo porque el código la referencia. `status` ahora abarca el ciclo completo: `PENDING → PROJECT_CREATED (8.1) → IMAGES_UPLOADED (8.2) → TRAINING → TRAINED | TRAINING_FAILED (8.3) → READY` (activo/publicado, 8.4), más `AWAITING_APPROVAL | REJECTED` (re-entrenamiento, 8.5) y `ERROR` (fallo de provisioning inicial, no de training). `TRAINED != READY`: un modelo puede terminar de entrenar sin estar publicado/activo todavía.

`RETSC_OP_SKUS` is accessed directly by `skuImageService.js` (via inline SQL, no dedicated repo) for EAN lookups and updating `image_url`/`has_visual_variant` on first image upload.

`RETSC_OP_SKUS` columns: `SKU_ID`, `EAN`, `image_url`, `creation_date`, `image_status`, `Product_dsc`, `status`, `selected_category_id`, `detection_category_id`. No `product_id` — `RETSC_OP_PRODUCTS` doesn't exist (verified via `INFORMATION_SCHEMA.TABLES` — fully removed, not just missing columns); `Product_dsc` and both category FKs live directly on this table now.

`RETSC_OP_ENTERPRISE_PRODUCT_SEG` columns: `seg_id` (PK identity), `enterprise_id` (FK → `RETSC_OP_ENTERPRISE`), `sku_id` (FK → `RETSC_OP_SKUS`), `status`, `created_at`, `updated_at`, `client_category`, `client_subcategory`, `Brand`, `Supplier`, `normalized_name`, `Relevant_feature`, `volume`; unique constraint `UQ_RETSC_ENTERPRISE_SKU_SEG` on `(enterprise_id, sku_id)`. This is the real enterprise↔SKU link — `RETSC_OP_ENTERPRISE_SKUS` never existed in any environment (an old naming assumption, not a removed table). No `selected_category_id`/`detection_category_id` here — platform categorization lives on `RETSC_OP_SKUS` (global); `client_category`/`client_subcategory` are the client's own categorization as typed in their Excel upload, a distinct concept. `normalized_name` is always `NULL` **on purpose** — `skuRepo.js`'s `insertEnterpriseSku`/`updateEnterpriseSku` never write it. Confirmed with the business team (2026-07-23): won't be implemented, because product-name normalization rules for Costa Rica are too inconsistent and there's no national electronic catalog to normalize against. Not a bug, not pending — don't reopen this without a new decision from the business side.

`RETSC_OP_ENTERPRISE_CATEGORIES` columns: `enterprise_category_id` (PK), `enterprise_id`, `selected_category_id` (FK → `RETSC_OP_CATEGORIES`), `resolved_category_id` (nullable — DTC-resolved override; falls back to `selected_category_id` when null), `status` (`'ACTIVE'` or other).

`RETSC_LOG_IMAGE_UPLOAD` real columns: `image_log_id`, `enterprise_id`, `upload_batch_id` (NOT NULL), `sku_id`, `ean`, `image_name`, `image_url`, `image_hash`, `image_status`, `process_status` (NOT NULL), `ocr_status`, `embeddings_status`, `error_code`, `error_message`, `created_at`. No `Product_id`, `Hash`, `Blob_url`, or `Status`.

`RETSC_LOG_SKU_UPLOAD` real columns: `log_id`, `enterprise_id`, `upload_batch_id` (NOT NULL), `row_number`, `ean`, `sku_description`, `selected_category_id`, `detection_category_id`, `process_status` (NOT NULL), `error_code`, `error_message`, `created_at`. **`loadStateRepo.js` uses `Job_id`, `Excel_data`, `Image_files`, `Metrics` — none of these columns exist. The old image-pipeline flow (`pipelineOrchestrator`) is non-functional and requires a DB schema redesign.**

When in doubt about column names, query: `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '<table>'`.

### Auth flow

Login issues two tokens: a short-lived `accessToken` and a long-lived `refreshToken`. The login response also includes `token` as an alias for `accessToken` for legacy frontend compatibility — do not remove it until the frontend migrates.

Login response includes `user.enterpriseDsc` so the frontend can display the enterprise name without an extra fetch.

JWT payload: `{ userId, email, username, enterpriseId, roleId, roleName }`. Use `req.user.roleName` for permission checks, always through `normalizeRole()`/`requireRole()` (see role system section above) — never compare the raw string directly. `requireAdmin` middleware enforces `ADMIN` or `ADMIN_DTC` and must be applied after `authMiddleware`.

Refresh token payload is minimal `{ userId, type: 'refresh' }` — the `type` field is checked during refresh verification to prevent access tokens from being used as refresh tokens. Refresh endpoint validates both signature and `type === 'refresh'`; throws 401 if either fails.

Login security: the password check runs before the user-existence check (timing-attack defense). Both "user not found" and "wrong password" return the same generic 401. If a user has multiple active enterprise relations, the **oldest** one is selected (`ORDER BY Fecha_activacion ASC, Enterprise_id ASC` in `userEnterpriseRepo.findActiveByUserId`, `authService.js` just takes `relations[0]`). Users with `Status != 1` or no active enterprise relations are rejected at login.

⚠ **Fixed 2026-07-26** — this used to be genuinely broken: `authService.js` picked the relation via `relations.reduce((min, r) => r.Id < min.Id ? r : min, ...)`, but `RETSC_OP_USRSXENTERP` has **no `Id` column at all** (columns are `User_id, Enterprise_id, Role_id, Status, Fecha_activacion, Fecha_inactivacion, Phone` — verified via `INFORMATION_SCHEMA`). `r.Id` was always `undefined`, so `undefined < undefined` was always `false` and the "pick the oldest" rule never actually ran — login/refresh silently returned whichever relation SQL Server happened to return first (no `ORDER BY` existed then), for any user with more than one active enterprise. Confirmed against real production data that this affected real users (3 users had >1 active relation at the time of the fix). If this surfaces again as "wrong role after login" for a multi-enterprise user, check `Fecha_activacion` on their relations — that's the real ordering key now, not a nonexistent `Id`.

All email inputs are normalized via `email.trim().toLowerCase()` before processing in login, register, and forgot-password.

Refresh flow: `POST /api/auth/refresh` takes `{ refreshToken }` in the body and returns a new `accessToken`. Logout is stateless — no server-side token revocation.

Forgot password flow: `POST /api/auth/forgot-password` accepts `{ identifier }` (email or username), generates a new 10-character password (from an alphabet that excludes ambiguous chars like `0/O`, `1/I/l`), updates it in the DB, and emails it to the user. Always returns the same generic message regardless of whether the user exists (prevents user enumeration). There is no change-password endpoint — only this forgot-password flow exists.

### Middleware mounting pattern

`src/app.js` applies `authMiddleware` globally for some route groups, but other groups do **not** receive it at mount time — those route files apply `authMiddleware` inline per protected route instead (`/api/sku-images` applies it inline on every single route, so it behaves identically to global mounting). When adding a new route file, check whether to apply auth at the app level or per route. `requireAdmin`/`requireRole` are always applied inline after `authMiddleware`, never globally. Current mount table:

```
/api/auth                                    — no global auth (each route decides)
/api/enterprises                             — no global auth (each route decides)
/api/products                                — no global auth (each route decides)
/api/sku-images                              — no global auth (each route decides, but applied inline on every route)
/api/skus                                    — no global auth; GET /global adds authMiddleware + requireRole(ADMIN_DTC) inline (added 2026-07-25, F4 menu)
/api/users                        authMiddleware  + requireAdmin on ALL routes (router.use, added 2026-07-25); GET /global additionally requires requireRole(ADMIN_DTC) (F4 menu)
/api/categories                   authMiddleware
/api/roles                        authMiddleware  + requireAdmin on GET routes, requireRole(ADMIN_DTC) on write routes (added 2026-07-25)
/api/enterprises/me/categories               authMiddleware
/api/enterprises/me/enterprise-categories    authMiddleware   (enterpriseCommercialCategoryRoutes.js)
/api/annotations                  authMiddleware  + requireRole(ANNOTATION_VALIDATOR_ROLES) inline on approve/correct/reject AND on the /photos review-queue routes (added 2026-07-25, F4 menu) — GET /photo/:photoId (singular, older route) stays open to any authenticated user
/api/models                        authMiddleware  + requireRole(MODEL_MANAGER_ROLES) inline on all routes, including the new GET / (F4 menu, 2026-07-25)
/api/shelf-photos                  authMiddleware  + requireRole(SHELF_UPLOAD_ROLES) inline on upload
/api/training                      authMiddleware  + requireRole(TRAINING_ADMIN_ROLES) inline on all routes
```

`enterpriseCommercialCategoryRoutes.js` is distinct from `enterpriseCategoryRoutes.js` — it exposes `GET /api/enterprises/me/enterprise-categories` (commercial categories) and `GET /api/enterprises/me/enterprise-categories/smart` (only `is_smart_dtc=1` categories, used to populate SKU-upload/shelf-photo-upload dropdowns), both handled by `categoryController.js` (no separate controller file).

### API routes

| Route | Auth | Notes |
|---|---|---|
| `POST /api/auth/register` | No | bcrypt hash, SQL insert |
| `POST /api/auth/login` | No | returns accessToken + refreshToken + user (includes enterpriseDsc) |
| `POST /api/auth/refresh` | No | returns new accessToken |
| `POST /api/auth/logout` | No | stateless response |
| `POST /api/auth/forgot-password` | No | generates new password, emails it |
| `GET /api/auth/me` | Bearer | Current user |
| `GET /api/auth/users` | Bearer | All users |
| `POST /api/enterprises` | No | Register enterprise + admin user; validates Costa Rica cédula jurídica (10 digits) + admin cédula física (9 digits) |
| `GET /api/enterprises` | Bearer + Admin | `ADMIN_DTC` sees all enterprises; plain `ADMIN` sees only their own (alias of /list) |
| `GET /api/enterprises/list` | Bearer + Admin | Same as above |
| `GET /api/enterprises/:id` | Bearer + Admin | Enterprise detail; 403 for a plain `ADMIN` if `:id` isn't their own enterprise |
| `POST /api/enterprises/create` | Bearer + `ADMIN_DTC` | Create enterprise (no admin user) — DTC-only |
| `PUT /api/enterprises/:id` | Bearer + Admin | Update enterprise (accepts status field); same per-enterprise restriction as the GET above |
| `GET /api/users` | Bearer + Admin | Users of the authenticated enterprise |
| `POST /api/users` | Bearer + Admin | Create + assign user to enterprise; sends a best-effort welcome email; if cédula belongs to a user with no active relations, reactivates instead of creating; if it belongs to a user with an active relation elsewhere, 409 `{code:'CEDULA_EXISTS'}` without revealing user data (traslado gestionado por el call center de DTC); assigning `roleId=ADMIN_DTC` additionally 403s unless the actor is themselves `ADMIN_DTC` (`assertCanAssignRole`) |
| `PUT /api/users/:id` | Bearer + Admin | Update user |
| `PUT /api/users/:userId/enterprises/:enterpriseId` | Bearer + Admin | Update user-enterprise relation; assigning `roleId=ADMIN_DTC` additionally 403s unless the actor is themselves `ADMIN_DTC` (`assertCanAssignRole`) |
| `GET /api/users/global` | Bearer + `ADMIN_DTC` | Cross-enterprise user listing (F4 menu, "Usuarios globales"); single JOIN (not N+1 like `listByEnterprise`), includes `enterpriseDsc` |
| `GET /api/roles` | Bearer + Admin | List all roles; `?active=1` filters to `status=1` only |
| `GET /api/roles/:id` | Bearer + Admin | Role detail |
| `POST /api/roles` | Bearer + `ADMIN_DTC` | Create role |
| `PUT /api/roles/:id` | Bearer + `ADMIN_DTC` | Update role |
| `PATCH /api/roles/:id/status` | Bearer + `ADMIN_DTC` | Activate/deactivate role |
| `GET /api/categories` | Bearer | Global category tree |
| `GET /api/categories/roots` | Bearer | Root categories only |
| `GET /api/categories/:id/children` | Bearer | Children of a category |
| `GET /api/categories/:id` | Bearer | Single category |
| `POST /api/categories` | Bearer | Create category |
| `PUT /api/categories/:id` | Bearer | Update category |
| `DELETE /api/categories/:id` | Bearer | Soft-delete category + cascade |
| `GET /api/enterprises/me/categories` | Bearer | Enterprise's selected categories |
| `PUT /api/enterprises/me/categories` | Bearer | Atomically replace enterprise category selection |
| `GET /api/enterprises/me/enterprise-categories` | Bearer | Enterprise's commercial categories with `enterprise_category_id` (used for SKU upload) |
| `GET /api/enterprises/me/enterprise-categories/smart` | Bearer | Enterprise's smart-DTC categories only, with parent info (feeds SKU/shelf-photo upload category pickers) |
| `GET /api/products` | Bearer | Products with pagination/search |
| `GET /api/products/global` | Bearer + `ADMIN_DTC` | Global product catalog (F4 menu, "Productos") derived from `RETSC_OP_SKUS` — no enterprise/client data; grouped by `(Product_dsc, detection_category_id)`, see `PRODUCT_GROUP_KEY_EXPR` in `skuRepo.js` |
| `GET /api/skus/global` | Bearer + `ADMIN_DTC` | Global paginated SKU catalog listing (F4 menu, "SKUs globales"); search by EAN/`Product_dsc` |
| `POST /api/products/upload-excel` | Bearer | Parse `.xlsx`; returns rows + errors |
| `POST /api/products/upload-images` | Bearer | Up to 200 images → `uploads-temp/<jobId>/` |
| `POST /api/products/process/:jobId` | Bearer | Start async pipeline |
| `GET /api/products/processing-status/:jobId` | Bearer | Poll pipeline state |
| `GET /health` | No | `{status, timestamp}` |
| `POST /api/categories/:id/retry-ai-infra` | Bearer + Admin | Reintenta provisioning IA de categoría smart |
| `POST /api/sku-images/upload` | Bearer | Up to 200 images; enqueues a `RETSC_LOG_JOBS` row and returns 202 immediately (see async job flow below) |
| `GET /api/sku-images/jobs` | Bearer | List the authenticated user's SKU-image upload jobs |
| `GET /api/sku-images/jobs/:jobId` | Bearer | Poll a specific job's status/counters |
| `GET /api/sku-images/sku/:skuId` | Bearer | List images for a SKU |
| `POST /api/sku-images/:featureId/validate` | Bearer | Runs the local pixel quality gate (`imageValidationService`) on an already-uploaded SKU image |
| `GET /api/annotations/photo/:photoId` | Bearer | List bounding-box annotations for a shelf photo |
| `GET /api/annotations/photo/:photoId/readiness` | Bearer | `{ total, validated, ready }` — whether photo has ≥1 validated annotation |
| `GET /api/annotations/photos` | Bearer + `ANNOTATION_VALIDATOR_ROLES` | Review queue (F4 menu, "Anotaciones"/"Revisar cajitas"); optional `categoryId`/`canal`/`status` query params, one row per photo |
| `GET /api/annotations/photos/:photoId` | Bearer + `ANNOTATION_VALIDATOR_ROLES` | Single photo detail with all its bounding boxes |
| `PATCH /api/annotations/photos/:photoId/approve` | Bearer + `ANNOTATION_VALIDATOR_ROLES` | Bulk-approves every annotation on a photo, then triggers `annotationSyncService.syncApprovedPhoto()`; body `{clienteAjustoCajitas?: boolean}` (default `true`); never 500s on a Custom Vision sync failure — returns `sync` result alongside `annotations` |
| `PATCH /api/annotations/:id/approve` | Bearer + `ANNOTATION_VALIDATOR_ROLES` | Mark one annotation validated |
| `PATCH /api/annotations/:id` | Bearer + `ANNOTATION_VALIDATOR_ROLES` | Correct bbox coordinates and mark validated |
| `DELETE /api/annotations/:id` | Bearer + `ANNOTATION_VALIDATOR_ROLES` | Hard-delete (reject) an annotation; 409 if it's the photo's last remaining one |
| `GET /api/models` | Bearer + `MODEL_MANAGER_ROLES` | Global model listing, all categories/versions (F4 menu, "Modelos de detección") |
| `GET /api/models/category/:categoryId` | Bearer + `MODEL_MANAGER_ROLES` | List all model versions for a category |
| `GET /api/models/category/:categoryId/can-retrain` | Bearer + `MODEL_MANAGER_ROLES` | Check the ≥`MODEL_RETRAIN_MIN_PHOTOS` rule |
| `POST /api/models/category/:categoryId/retrain` | Bearer + `MODEL_MANAGER_ROLES` | Start a new training version (202) |
| `POST /api/models/category/:categoryId/rollback/:version` | Bearer + `MODEL_MANAGER_ROLES` | Reactivate an older, previously-deactivated version |
| `POST /api/models/:modelId/complete` | Bearer + `MODEL_MANAGER_ROLES` | Persist `{precision, recall, meanAp, raw?}`; auto-activates or sets `AWAITING_APPROVAL` |
| `POST /api/models/:modelId/approve` | Bearer + `MODEL_MANAGER_ROLES` | Approve and activate a version stuck in `AWAITING_APPROVAL` |
| `POST /api/models/:modelId/reject` | Bearer + `MODEL_MANAGER_ROLES` | Reject a version in `AWAITING_APPROVAL`; previous version stays active |
| `POST /api/shelf-photos/upload` | Bearer + `SHELF_UPLOAD_ROLES` | 8-stage quality-gated shelf-photo ingestion (see below) |
| `POST /api/training/models/:categoryId/train` | Bearer + `TRAINING_ADMIN_ROLES` | Dispara entrenamiento en Custom Vision (202, fire-and-forget); requiere `status='IMAGES_UPLOADED'` |

### Enterprise registration

`POST /api/enterprises` creates an enterprise plus an admin user in one operation. The `type` field must be one of: `"Proveedor"`, `"Detallista"`, `"Empresa de servicios"`. If the admin user already exists by `cédula` with no active relations, the user is reactivated with a fresh generated password instead of creating a new record.

This operation is **not** wrapped in a SQL transaction — it uses manual compensating rollbacks (delete enterprise then delete user) if a later step fails. This is unlike `enterpriseCategoryRepo.js`, which uses an explicit `pool.transaction()`. Be aware of this gap when modifying the registration flow.

### Enterprise status

`RETSC_OP_ENTERPRISE` has a `status` column (lowercase, BIT). Note: unlike other tables in the project that use `Status` (Pascal case), this column is lowercase — always reference it as `row.status` in the repository layer, not `row.Status`.

### Product ingestion pipeline

`src/services/pipelineOrchestrator.js` runs an async 7-step job tracked in `RETSC_LOG_SKU_UPLOAD` — this describes the **original intended design**; the pipeline is non-functional today (see `RETSC_LOG_SKU_UPLOAD` note below) and step 6 additionally calls now-removed `productRepo` functions (`findByGtinAndEnterprise`/`insertMany`/`update`) that targeted a table (`RETSC_OP_PRODUCTS`) which no longer exists:

1. **validating_gtins** — filters rows against EAN8/UPC12/EAN13 check digits
2. **hashing** — SHA-256 dedup against `RETSC_LOG_IMAGE_UPLOAD` and within the batch
3. **matching** — GTIN from image filename prefix (e.g. `0123456789012_front.jpg`) matched to Excel rows; one image per GTIN
4. **hierarchy** — calculates blob subfolder depth based on product counts vs. `BLOB_HIERARCHY_THRESHOLD`; path segments are slugified (lowercase, accent-stripped, spaces → hyphens)
5. **uploading** — uploads to Azure or mock in batches of 10 with exponential-backoff retry (1s/2s/4s, 3 attempts); fails job if >50% fail
6. **persisting** — was meant to upsert products and insert image records into `RETSC_LOG_IMAGE_UPLOAD`
7. **ai_tracking** — records `pending_training` entries in `RETSC_AI_DETECTION_MODELS` per category

Pipeline is fire-and-forget: `POST /process/:jobId` returns immediately; clients poll `/processing-status/:jobId`.

### SKU image ingestion (`/api/sku-images`)

`src/services/skuImageService.js` handles direct per-SKU image uploads (distinct from the Excel pipeline above). Files are uploaded one batch at a time; each file goes through:

1. **Parse filename** — `skuImageFilenameParser.js` extracts `{EAN}_{view}.{ext}` (jpg/png/webp only, 10 MB max)
2. **Hash** — SHA-256 dedup against `RETSC_AI_SKU_FEATURES`
3. **SKU lookup** — queries `RETSC_OP_SKUS` by EAN; if no match → **orphan flow**
4. **Blob prefix** — `dtc-{slug}` for smart-DTC categories, `sin-categoria-smart` otherwise, `huerfanas/` for orphans
5. **Upload** — to `AZURE_GLOBAL_TRAINING_CONTAINER` (default `global-sku-training`)
6. **Insert feature** — row in `RETSC_AI_SKU_FEATURES`; standard key-value metadata in `RETSC_AI_SKU_IMAGE_METADATA`
7. **Log** — every attempt (processed/orphan/duplicate/error) goes to `RETSC_LOG_IMAGE_UPLOAD`

**Orphan flow**: images with an EAN that has no matching SKU are uploaded to `huerfanas/{EAN}_{view}.{ext}` and logged with `process_status='ORPHAN'`. When a SKU is later created for that EAN, call `resolveOrphansForSku(skuId, ean)` to retroactively adopt them (inserts into `RETSC_AI_SKU_FEATURES`, marks log as `ADOPTED`). This hook is not yet wired to the SKU creation endpoint.

The first image uploaded for a SKU sets `is_primary=1` and updates `image_url` + `has_visual_variant` on `RETSC_OP_SKUS`.

**Async job wrapper**: `POST /api/sku-images/upload` no longer processes synchronously. `jobService.js` creates a `RETSC_LOG_JOBS` row (`job_type='SKU_IMAGE_UPLOAD'`), returns `202 { jobId, status: 'QUEUED', totalFiles }` immediately, then runs `processJob()` via `setImmediate()` (in-process fire-and-forget, not a real worker queue) which calls `skuImageService.processBatch()` with an `onProgress` callback updating `processed_count`/`orphan_count`/`duplicate_count`/`error_count`, finishing as `COMPLETED`/`FAILED`. Clients poll `GET /api/sku-images/jobs/:jobId` (or list via `GET /api/sku-images/jobs`).

**Post-upload queue handoff**: after each successful per-image upload, `queueService.js` posts a base64-encoded `{ sku_id, feature_id, image_url, ean }` message to an Azure Storage Queue (`AZURE_QUEUE_NAME`, default `sku-image-processing`) for an external Azure Function (`ProcessSkuImageQueue`, not in this repo) to run OCR + embeddings and update `RETSC_AI_SKU_FEATURES`. If `AZURE_STORAGE_CONNECTION_STRING` is unset, `queueService` silently no-ops — enqueueing must never break the upload.

**Local quality gate**: `POST /api/sku-images/:featureId/validate` runs `imageValidationService.js` (LOW_RESOLUTION/BLURRY/POOR_LIGHTING via `imageQualityAnalyzer.js`, thresholds 800×800 / sharpness 100 / brightness 40–220) — a separate, independently-tuned threshold set from the shelf-photo quality gate below. It's a pure function; the controller persists the result. Run before costly Azure OCR/embeddings calls.

### Shelf photo ingestion (`/api/shelf-photos`, Issues 7.1/7.2)

Shelf photos ("góndola" photos) are **global** training data for the shelf-detection model — distinct from SKU images, which train product identification. Because a single bad photo degrades the shared model for every enterprise, uploads pass an 8-stage quality gate (`shelfPhotoUploadService.js`) before landing in the training set:

1. Validate `canal` (`OMT`|`DTT`|`CONVENIENCE`) and that `dtcCategoryId` exists with `is_smart_dtc=1`.
2. **Pixel quality** — `imageQualityValidator.validateImageQuality()` (sharp): resolution ≥ `QUALITY_MIN_WIDTH`×`QUALITY_MIN_HEIGHT`, sharpness > `QUALITY_MIN_SHARPNESS` (normalized Laplacian variance), brightness within `[QUALITY_MIN_BRIGHTNESS, QUALITY_MAX_BRIGHTNESS]`. First failing criterion returns 422 with its error code.
3. **Caption confidence** — `azureVisionService.analyzeCaption()`, a **permissive stub** (`confidence:1, accepted:true`) even when Azure Vision credentials are set — the SDK call isn't implemented yet.
4. **Content check** — `azureVisionService.isShelf()`, also a permissive stub.
5. **Dedup** — SHA-256 hash, global scope (`ENTERPRISE_ID IS NULL`) via `shelfPhotoRepo.findByHashGlobal()`; duplicate → 409 `ERR_DUPLICATE_IMAGE`.
6. **Upload** — to `AZURE_GLOBAL_SHELF_CONTAINER` at `dtc-{categorySlug}/{canal-lowercase}/{filename}`; filename is server-generated (`shelfPhotoFilenameGenerator.js`), never user-supplied. Then insert the `RETSC_EX_SHELFPHOTO` row.
7. **Custom Vision registration (no regions yet)** — looks up the category's `customvision_project_id` via `aiModelRepo`, calls `customVisionService.createImageFromData()` (real upload, implemented 2026-07-19) to get a real `cvImageId`, then inserts an `RETSC_AI_TRAINING_ANNOTATIONS` row with `is_validated=0`, `source='ADMIN_UPLOAD'`, bboxes NULL (filled in later by the annotation-review flow below).
8. **Threshold check** (non-blocking) — if validated+approved annotation count for that category/canal reaches `SHELF_TRAINING_THRESHOLD`, the model's `status` flips to `IMAGES_UPLOADED`.

`shelfPhotoQualityService.assessPhoto()` (a per-enterprise dedup variant, documented in its own file header as the intended entry point) is **dead code** — only the global-scope `validateQualityMetrics()` path above is actually wired to the controller.

### Annotation review (`/api/annotations`, Issue 7.5)

Reviews and corrects the bounding boxes (`RETSC_AI_TRAINING_ANNOTATIONS`) that Custom Vision needs to learn "where is a product" in a shelf photo. `annotationService.js`:
- **approve(id, reviewerId)** — sets `is_validated=1` + reviewer/timestamp.
- **correct(id, bbox, reviewerId)** — validates the bbox is normalized to `[0,1]` (`validateBbox()`, 400 on NaN/negative/overflow), updates coordinates, and also marks `is_validated=1`.
- **reject(id)** — hard-deletes the row; **cannot reject a photo's last remaining annotation** (409 — "use the whole-photo-rejection flow instead", which does not exist yet).
- **getPhotoReadiness(photoId)** — `{ total, validated, ready: validated >= 1 }`, checked before sending a photo to Custom Vision.

Route ordering matters: `/photo/:photoId` routes are registered before `/:id` in `annotationRoutes.js` so Express doesn't match `photo` as an `:id` param.

`annotationRepo.approvePhoto(photoId, reviewerId)` (bulk-approves every annotation on a photo and sets `photo_approved=1`) exists and is exported, but **is called from nowhere** — no service method or route wires it up yet. Treat it as a known gap if a "approve whole photo" endpoint is requested.

### Model versioning (`/api/models`, Issue 8.5)

Extends `RETSC_AI_DETECTION_MODELS` (already created per-category by the smart-category AI infra flow above) with a version history. `modelVersioningService.js`:
- **canRetrain(categoryId)** — counts newly-validated photos since the active model's `trained_at`; requires ≥ `MODEL_RETRAIN_MIN_PHOTOS`.
- **startRetrain(categoryId)** — 409 if the photo-count rule isn't met; otherwise inserts a new row at `model_version = max+1`, `status='TRAINING'`, `is_active=0` (the old version stays active until the new one is validated). Actually triggering Custom Vision training here is still a stub (comment references a `triggerTraining()` that doesn't exist) — **not** wired to `modelTrainingService.startTraining()` / `customVisionService.trainProject()` (Issue 8.3), which is a separate, real flow reached only via `POST /api/training/models/:categoryId/train`. Retraining a category today goes through the `/api/training` route, not through `startRetrain()`.
- **completeRetrain(modelId, {precision, recall, meanAp, raw})** — persists metrics, stamps `trained_at`, then compares `mean_ap` against the currently-active model's via `isWorse()` (worse if `newMap < activeMap - MODEL_METRIC_TOLERANCE`; missing metrics count as worse). Worse → `status='AWAITING_APPROVAL'`; otherwise auto-activates (deactivates all other versions for the category, sets this one active + `status='READY'`).
- **approveVersion / rejectVersion** — only valid from `AWAITING_APPROVAL` (409 otherwise); approve activates the version, reject sets `status='REJECTED'` and leaves the previous version active.
- **rollback(categoryId, version)** — reactivates an old, never-deleted version via the same `setActiveVersion()` path.

`aiModelRepo.setActiveVersion()` runs as two sequential UPDATEs (deactivate-all, then activate-one) **without** a SQL transaction — an explicit, acknowledged gap in the code comment, same pattern already flagged for enterprise registration elsewhere in this file.

### AI/vision services — live vs. legacy

| Service | Used by | Status |
|---|---|---|
| `imageValidationService.js`, `jobService.js`, `queueService.js` | `/api/sku-images` (active flow) | Live — make SKU image upload async/job-based and hand off OCR/embeddings to an external Azure Function |
| `customVisionService.js` | `aiInfrastructureService.js` (project creation), `shelfPhotoUploadService.js` (image upload), `annotationSyncService.js` (region sync), `modelTrainingService.js` (training) | Live (Issues 8.1/8.2/8.3, cerrado 2026-07-19) — every function calls the real Custom Vision Training API v3.3 via `fetch` once `isConfigured()`; no stubs left in this service |
| `azureVisionService.js` | `/api/shelf-photos` only | Permissive stub; ignores real credentials until the SDK call is implemented |
| `aiService.js`, `hierarchyService.js` | `pipelineOrchestrator.js` only | Tied to the legacy/broken Excel image pipeline (see `loadStateRepo.js` note above) |
| `matchingService.js` | `pipelineOrchestrator.js` (legacy), plus `extractGTINFromFilename()` used standalone by `productController.js` | Mixed — the service as a whole is legacy, but that one function still has a live caller |

### SKU ingestion flow (current)

`POST /api/skus/upload-excel` is the **active** SKU upload path (replaces the old image-pipeline for product cataloguing). It is **synchronous** — the response includes final `{ metrics, errors }` in one call.

Flow in `src/services/skuService.js`:
1. Validate `enterpriseCategoryId` belongs to the authenticated enterprise (`RETSC_OP_ENTERPRISE_CATEGORIES`); resolve `detectionCategoryId = resolved_category_id ?? selected_category_id`.
2. Parse the Excel file — required columns: `gtin` (aliases: `ean`, `barcode`, `codigo`, etc.) and `description`; optional: `brand`, `manufacturer`, `category`, `subcategory`, `volume`, `relevant`. Headers are accent/case-normalized.
3. For each row: validate EAN format (8, 12, or 13 numeric digits + GS1 checksum); find-or-create the SKU in `RETSC_OP_SKUS` by EAN (`selected_category_id`/`detection_category_id` set from the enterprise category resolved in step 1 — global, not per-empresa); insert-or-resync the enterprise↔SKU link in `RETSC_OP_ENTERPRISE_PRODUCT_SEG` with the client's own `brand`/`supplier`/`client_category`/`client_subcategory`/`volume`/`relevant_feature` from that row (an existing link gets its client data **updated**, not left stale, on repeat uploads); log to `RETSC_LOG_SKU_UPLOAD`.

`skuService.js` uses GTIN length heuristics to fix leading-zero loss: a 7-digit string is padded to 8, an 11-digit string to 12.

Supporting services for the pipelines above: `imageValidationService.js` (pre-OCR quality gate for SKU images: resolution/blur/brightness, mirrors `shelfPhotoQualityService.js`), `hierarchyService.js` (blob path depth decisions for the legacy product pipeline), `matchingService.js` (pairs uploaded image filenames to Excel rows by GTIN prefix), `aiService.js` (legacy pipeline's fallback registration of `RETSC_AI_DETECTION_MODELS` rows if `aiInfrastructureService` hasn't already created one), `queueService.js` (enqueues SKU images onto Azure Queue Storage for an external Function to run OCR/embeddings; never throws, no-ops if unconfigured).

### Excel parsing (legacy product pipeline)

`src/services/excelService.js` reads only the first sheet. Required columns: `gtin`, `description`, `category`. Optional: `subcategory`, `segment`, `brand`. Headers matched case-insensitively with accent normalization (e.g. `descripción`, `categoría`). GTINs with a leading zero preserved if total length is 12 or 13 digits. The xlsx library sometimes casts numeric GTINs to floats; excelService corrects this.

### Input validation

All email fields are validated with `isValidEmail()` from `src/utils/validators.js` before any DB operation. This applies to: auth register, user create/update, enterprise register/create/update. Returns HTTP 400 with message `'Formato de email inválido'` on failure.

Costa Rica cédula validation (`normalizeCedula()`, `isValidCedulaFisica()` — 9 digits, `isValidCedulaJuridica()` — 10 digits, all in `src/utils/validators.js`, Issue B5): `normalizeCedula()` strips dashes/spaces and **must** be used on both the validate and the persist side — comparing an un-normalized cédula against a normalized one stored earlier silently defeats duplicate detection. Used by `enterpriseService.registerEnterprise()`/`createEnterprise()` (fiscalId = jurídica, admin cédula = física) and `userService.createAndAssign()` (física).

### Column naming convention — critical

MSSQL repositories return raw SQL column names in Pascal_Case (`Role_id`, `Role_name`, `Description`, `Status`). **Services must always map these to camelCase before returning to controllers.** Use a local `toDTO(row)` function — see `roleService.js` for the established pattern. The frontend and JWT payload always use camelCase (`roleId`, `roleName`, `description`, `status`).

MSSQL `BIT` columns come back as JS booleans. Normalize them to `1`/`0` integers in `toDTO()` (e.g. `status: row.Status ? 1 : 0`) to keep the API contract consistent. Exception: `RETSC_OP_USRSXENTERP.Status` uses `!!r.Status` for the active-relations filter since it can be `true`, `1`, or `null`.

### Adding new features

Follow the existing pattern: route → controller → service → repository. All SQL access belongs in repositories only — controllers and services must not call `db.js` directly. When a repository returns MSSQL rows, always map them to camelCase in the service via a `toDTO()` function. Errors need a `statusCode` property for `handleError()` to forward the correct HTTP status — use the `svcError(msg, statusCode)` pattern found in every service. Note: some services (e.g. `authService.js`) define this helper as `serviceError` instead of `svcError` — both work identically. Standardize on `svcError` when adding new services.

When an operation must be atomic across multiple inserts/deletes (e.g. replacing a category set), use an explicit SQL transaction inside the repository — see `enterpriseCategoryRepo.js` for the pattern: `pool.transaction() → begin() → DELETE + INSERT loop → commit() / rollback()`. `enterpriseCategoryRepo.js` is the **only** repository in the codebase using explicit transactions.

File uploads (Excel and images) use `multer` middleware configured in the route files. Excel upload is single-file; image upload accepts up to 200 files at once, stored under `uploads-temp/<jobId>/` before the pipeline runs.

HTTP responses always follow `{ success: true, ...data }` on success and `{ success: false, message: "..." }` on error.

## Pending Work (TODOs)

These are known gaps tracked in the code. When implementing any of them, follow the architecture conventions above.

### 1. Cambiar contraseña (Change Password) — NOT IMPLEMENTED

There is no `change-password` endpoint. The only password-recovery mechanism is `POST /api/auth/forgot-password`, which generates a temporary password and emails it.

What needs to be built:
- **Route**: `PUT /api/auth/change-password` — protected with `authMiddleware`
- **Controller**: validate `{ currentPassword, newPassword }` body fields; enforce minimum length (currently 6 chars per `register` logic)
- **Service** (`authService.js`): verify `currentPassword` against the stored hash via `bcrypt.compare`, then hash the new password and call the repo
- **Repository** (`userRepo.js`): add `updatePassword(userId, hashedPassword)` — a simple `UPDATE RETSC_OP_USERS SET Password_hash = @hash WHERE User_id = @id`

### 2. `token` alias in login response — pending frontend migration

`src/controllers/authController.js:22-23` — The login response sends both `token` (legacy alias) and `accessToken` for the same value. The TODO comment reads: *"coordinar con frontend la migración a accessToken/refreshToken"*. Once the frontend stops reading `token`, remove the alias from the response object.

### 3. Login debug logs — must be removed

`src/controllers/authController.js:39-42` — Three `console.error('[LOGIN DEBUG] ...')` lines are marked *"borrar después de resolver el problema"*. Remove them once the login issue they were diagnosing is confirmed resolved.

### 4. Token revocation on logout — stateless by design, but flagged for future

`src/controllers/authController.js:66-68` — The logout handler is intentionally stateless. The comment explicitly notes: if real session-kill is needed in the future, add a revoked-tokens table and mark the `refreshToken` from the request body as revoked. No implementation is needed now, but be aware that blacklisting refresh tokens will require a new DB table and a check inside `authService.refreshAccessToken()`.

### 6. ~~Custom Vision — integración pendiente de credenciales~~ — COMPLETADO (Issues 8.1/8.2/8.3)

`src/services/customVisionService.js` ya **no** es un stub. `createProject()`, `createImageFromData()` (implementado 2026-07-19 — cerraba el único hueco que bloqueaba el sync E2E), `createImageRegions()`, `deleteImageRegion()`, `deleteImages()`, `trainProject()`, `getIteration()`, `getIterationPerformance()` hacen llamadas HTTP reales (vía `fetch` nativo, no el SDK oficial — la key de Azure AI Services unificada tiene caracteres no-ASCII que el módulo `http` de Node rechaza en headers). Probado end-to-end contra CV real: upload real → `createImageRegions` → `cv_region_id` poblado → segunda pasada no duplica (guarda `splitByCvRegionId`). Queda pendiente:
- **Issue #35 (tags por proyecto)**: `CV_TAG_OMT`/`DTT`/`CONVENIENCE` siguen siendo env vars globales, pero cada proyecto CV tiene sus propios tag IDs — con más de una categoría con proyecto activo simultáneo, una sola env var por canal no alcanza. Confirmado como limitación real en el E2E, no solo teórica. Requiere un mapeo canal+categoría→tagId persistido (no resuelto en el cierre de `createImageFromData()`, fuera de ese alcance).
- **Issue 8.4 (publicación)**: `publishIteration(projectId, iterationId)` no existe todavía.
- Correr la migración `006_add_metrics_to_detection_models.sql` — verificada como no aplicada en la BD real (ver sección de entrenamiento); sin ella `aiModelRepo.saveMetrics()` falla (silenciosamente, no bloquea el flujo).
- Los modelos en `RETSC_AI_DETECTION_MODELS` con `status='PENDING'` se actualizan mediante `POST /api/categories/:id/retry-ai-infra`.

### 7. ~~Columna `prefix` pendiente en `RETSC_INF_GLOBAL_BLOB_CONTAINERS`~~ — COMPLETADO

Migración `migrations/003_add_prefix_to_global_blob_containers.sql` agrega la columna `prefix VARCHAR(100)` y migra los valores existentes. `globalBlobContainerRepo.js` ya usa la columna directamente — los helpers temporales `buildDescription()` y `extractPrefixFromDescription()` fueron eliminados.

### 8. ~~Backfill de categorías smart existentes — script pendiente de crear~~ — COMPLETADO

Script creado en `scripts/backfill-smart-categories.js`. Correr con `npm run backfill:smart-categories -- --dry-run` primero, luego sin `--dry-run`. Pre-requisito: migración 003 debe estar aplicada. El script es idempotente.

### 9. Enterprise registration not wrapped in a SQL transaction

`src/services/enterpriseService.js` — The `POST /api/enterprises` flow (enterprise + admin user creation) uses manual compensating rollbacks instead of a real DB transaction. If a step fails mid-way, the service manually deletes the already-inserted enterprise or user. This is a known gap. If this flow is expanded, consider wrapping it in `pool.transaction()` following the `enterpriseCategoryRepo.js` pattern.

### 10. ~~Annotation "review queue" endpoints not wired~~ — RESUELTO 2026-07-25 (menú por rol)

`annotationRepo.js`'s `listPhotos({categoryId, canal, status})`, `getPhotoWithRegions(photoId)`, and `approvePhoto(photoId, reviewerId)` were dead code (no route) until the F4 menu work needed a review queue for the "Anotaciones" (`ADMIN_DTC`) and "Revisar cajitas" (`ADMIN`) menu items. Now wired as `GET /api/annotations/photos`, `GET /api/annotations/photos/:photoId`, `PATCH /api/annotations/photos/:photoId/approve` (all gated by `ANNOTATION_VALIDATOR_ROLES`, unlike the older `GET /photo/:photoId` which is open to any authenticated user).

Two things fixed/added along the way:
- `listPhotos()`'s `categoryId` was bound unconditionally (even `undefined`), and the `WHERE dtc_category_id = @categoryId` was unconditional too — with no `categoryId`, SQL Server's `NULL` comparison matched **zero rows**, silently breaking the exact "all categories" case this new global endpoint needs. Confirmed empirically (`listPhotos({})` returned 0 rows before the fix) — now `categoryId` only appears in the `WHERE` when actually provided, same pattern as `canal`/`status`.
- The approve route now calls `annotationSyncService.syncApprovedPhoto()` right after `approvePhoto()` persists — see the Custom Vision sync section above for why, and the note there about this being a second trigger alongside the still-unintegrated Issue #54.

### 11. `azureVisionService.js` ignores real credentials

`analyzeCaption()` and `isShelf()` return permissive stub results (`accepted:true`/`isShelf:true`) unconditionally — even when `AZURE_VISION_ENDPOINT`/`AZURE_VISION_KEY` are set, it only logs a warning and still returns the stub, because the actual Azure AI Vision SDK call was never implemented. To finish: install `@azure-rest/ai-vision-image-analysis` + `@azure/core-auth` and implement the two TODO'd calls. Needed before the shelf-photo quality gate can reject bad captions/non-shelf images in production.

### 12. `shelfPhotoQualityService.assessPhoto()` is dead code

Documented in its own file header as the intended per-enterprise entry point, but `shelfPhotoUploadService.js` only calls `validateQualityMetrics()` (the global-scope helper) instead. No controller or route calls `assessPhoto()`. Either wire it up if a per-enterprise shelf-upload flow is needed, or remove it.

### 13. Cédula format validation not implemented (documented proposal, not built — `docs/TODO-prioridad-3.md`)

`ced_identidad`/`cedIdentidad` is checked for "not empty" only, in three places: `userService.createAndAssign()`, `enterpriseService` (admin cédula on enterprise registration), and `userRepo.findByCedula()` (exact-match lookup, no format check). There is no `src/utils/cedulaValidator.js` today, unlike `gtinValidator.js` which does have a real checksum validator. Proposed design (not agreed/built): física = 9 digits, jurídica = 10 digits starting with `3`, no official public check-digit (format/length only, not checksum); a `validateCedula(value, { tipo })` helper mirroring `gtinValidator.js`'s self-test pattern. Open question flagged in the doc: whether legacy production data already conforms to these rules before enforcing on existing reads vs. only new writes.

### 14. Role-based authorization gap on core business endpoints (`docs/TODO-prioridad-3.md`) — PARTIALLY CLOSED 2026-07-25

`/api/users` and `/api/roles` are **no longer** in this gap — see the audit below. What's still open: `/api/categories` (read routes only — writes are already `ADMIN_DTC`-only, Issue B4), `/api/enterprises/me/categories` (both read **and** write), `/api/products`, `/api/skus`, `/api/sku-images`, and `/api/annotations` (read routes — the approve/correct/reject writes already gate on `ANNOTATION_VALIDATOR_ROLES`). Any authenticated user of an enterprise can still call any of these regardless of `roleName`. Still explicitly **not** implemented pending a product decision (roleName → allowed-actions matrix agreed with the team, likely per frontend screen) — do not invent a permissions matrix unprompted for these. Once a matrix exists, the existing `requireRole(...roles)` pattern is sufficient; no new middleware is needed unless the matrix grows complex enough to warrant a DB-backed `RETSC_OP_ROLE_PERMISSIONS` table (mentioned in the doc as a future option, not needed yet).

**Audit 2026-07-25 (pre menu-reorder, closed for users/roles):** verified by exercising all 47 routes against tokens for the 5 roles — `POST /api/roles`, `PUT /api/roles/:id`, `PATCH /api/roles/:id/status`, `GET/POST /api/users`, `PUT /api/users/:id`, and `PUT /api/users/:userId/enterprises/:enterpriseId` responded 200/400/404 (never 403) for `EJECUTIVO CAMPO`/`GERENCIA`/`AUDITOR CAMPO` tokens. Concrete impact: `userService.createAndAssign()` accepted any `roleId` from the request body with no check beyond "role exists" — any authenticated user could create an `ADMIN` or `ADMIN_DTC`; and `userService.updateUserEnterprise()` let a user reassign their **own** enterprise-relation role, so an `AUDITOR CAMPO` could self-promote to `ADMIN` inside their own enterprise. Fixed by: `userRoutes.js` now applies `requireAdmin` to the whole router; `roleRoutes.js` splits read (`requireAdmin`) from write (`requireRole(ROLES.ADMIN_DTC)`, matching the category-taxonomy precedent in Issue B4); and `userService.assertCanAssignRole()` adds defense-in-depth so that even an `ADMIN` (not just non-admins) cannot assign the `ADMIN_DTC` role to anyone — only an existing `ADMIN_DTC` can grant `ADMIN_DTC`. Verified with `scripts/test-user-role-gates.js` (9/9, no DB access).

**On the "do not invent a permissions matrix" rule above:** that instruction was revoked *only* for `/api/users` and `/api/roles`, and only because the gap there was a live privilege-escalation path (any authenticated role could mint an `ADMIN_DTC`), not a product preference to weigh in on. It still applies as written to every other endpoint listed at the top of this section — those are pending the owner's role↔menu mapping, not a security hole, and should not be gated unprompted.

### 15. Welcome-email "set your own password" flow not implemented (`docs/TODO-prioridad-3.md`)

When an admin creates a user (`userService.createAndAssign`), the admin supplies the password directly in the request body — there is no "user gets an email, clicks a link, sets their own password" flow (the only email-driven password flow today is `forgotPassword`, which generates and emails a random password). A table `RETSC_INF_ACTIVATION_TOKENS` (`token_id`, `token`, `enterprise_id`, `admin_email`, `created_at`, `expires_at`, `used`, `used_at`) exists in the DB but has **no code reference** anywhere except being wiped by `scripts/cleanup-for-testing.js` — it's empty in production and, by its shape (`enterprise_id`+`admin_email`, no `user_id`), looks like it was meant for activating a new enterprise's admin (`POST /api/enterprises`) rather than a user created later by that admin. Do not assume it's reusable for the latter without confirming with the team what it was originally built for. Proposed design in the doc: new (or extended) token table with `user_id`, a `POST /api/auth/set-password` public endpoint, and a new `FRONTEND_URL` env var that doesn't exist yet.

### 16. ~~Menu reordering / role-based visibility — blocked on design~~ — UNBLOCKED 2026-07-25 (`docs/TODO-menu-roles.md`)

María (project owner) confirmed the menu↔role mapping on 2026-07-25 — see "Menú por rol (F4)" below for the mapping itself and what it did/didn't require from this backend. `src/config/roles.js` (`ROLES` + `normalizeRole()`) and the `requireRole`-per-route-group pattern (precedent: `enterpriseController.js`'s `isAdminDtc()` branching, `categoryRoutes.js`'s role-restricted route group) turned out to be exactly what was needed — no new middleware pattern was invented for this. Visibility ended up being **both**: the frontend hides/shows menu items by reading `user.roleName` (no backend change needed for that part), but four menu items also needed brand-new endpoints (see below) since nothing existed to power them yet.

