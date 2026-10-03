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
node scripts/test-shelf-photo-quality.js # Integration tests for shelf-photo quality gate + dedup (hits real DB)
node scripts/check-connectivity.js       # Read-only diagnostic: pings SQL, blob storage, and other external services
node scripts/dump-schema.js              # Read-only: dumps every real table/column/PK/FK/index from the connected DB into docs/DB-SCHEMA.md
node scripts/cleanup-for-testing.js      # DESTRUCTIVE — wipes all tables except users/enterprises/roles + global-sku-training blobs
node scripts/verify-smart-categories-dedup.js <enterpriseId>  # Read-only: checks for duplicate category/parent names in an enterprise's smart-category listing (Issue B4 regression check)
node scripts/test-user-role-gates.js     # Guard anti-escalada a ADMIN_DTC (userService.assertCanAssignRole); NO toca la BD — stubea repos vía require.cache
node scripts/run-ocr-embedding-validation.js [--limit=N] [--dry-run]   # Pasos 1-5 de la validación OCR+embeddings (ver guía v1.9 / sección propia más abajo); hits real DB + Azure Vision/OpenAI/Search
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
- `AZURE_VISION_ENDPOINT`, `AZURE_VISION_KEY` — Azure AI Vision (Image Analysis) credentials, shared by two independent consumers: `azureVisionService.js` (shelf-photo caption/content checks — stays a permissive stub even when these are set, SDK call not implemented yet) and `visionOcrService.js` (real OCR, `features=read`, added 2026-08-04 for `scripts/run-ocr-embedding-validation.js` — see that section below)
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
- `MODEL_MANAGER_ROLES` — CSV of roles allowed to list AI detection models (`GET /api/models`, `GET /api/models/category/:categoryId`; default `ADMIN,ADMIN_DTC`) — the retrain/approve/reject/rollback actions this env var used to gate were retired 2026-08-03 (see "Model versioning" section below)
- `CV_TAG_OMT`, `CV_TAG_DTT`, `CV_TAG_CONVENIENCE` — **sin uso desde 2026-08-03** (Issue #35 resuelto): `annotationSyncService.js`'s `resolveTagId()` no lee estas env vars más — ahora resuelve el tag on-demand dentro del proyecto CV de la categoría vía `customVisionService.ensureTag(projectId, canal)` (crea el tag la primera vez, reusa si ya existe; nombre = el canal solo, `'OMT'`/`'DTT'`/`'CONVENIENCE'`). No se quitaron del `.env`/código como valores por si se necesitan de referencia, pero ningún route/service las lee.
- `TRAINING_ADMIN_ROLES` — **sin uso** desde 2026-08-03: gateaba `POST /api/training/models/:categoryId/train`, que fue eliminado por completo (decisión de jefatura — ver "Entrenamiento de modelos" más abajo). No se quitó del `.env`/código por si el disparo automático que lo reemplaza reusa el mismo rol, pero hoy ningún route file lo lee.
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` (default `text-embedding-ada-002`) — agregadas 2026-08-04 para `embeddingService.js`/`skuSearchService.buscarSkuPorTexto()` (guía v1.9 sección 7.2). Deben apuntar al **mismo recurso/deployment** que usa `Functions/src/lib/openaiEmbedding.js` (repo hermano) para poblar `retsc-sku-vectors` — si no coinciden, los vectores no son comparables. Ver "Búsqueda de SKU por texto" más abajo.

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

Todo lo demás del menú se resolvió con endpoints que ya existían. Al momento de este mapeo (2026-07-25) estaba **fuera de alcance** (sin tabla/datos en la BD para soportarlo, implementado como "Pronto" en el frontend sin backend): Tiendas activas, Planogramas (no había tabla de retailers — `RETSC_EX_SHELFPHOTO.Retailer_id` era solo una columna suelta sin catálogo detrás), Surtido, y todo el bloque operativo de `GERENCIA` (Visitas, KPIs de cumplimiento, Faltantes detectados, Reportes por tienda/producto/ejecutivo, Ejecutivos de campo).

⚠ **ACTUALIZACIÓN 2026-07-26 — ese "fuera de alcance" ya NO es cierto a nivel de esquema.** Investigando B7 (dashboard) apareció que el equipo DBA aprovisionó, como parte de la misma migración que trajo `RETSC_AI_TRAINING_PHOTOS` (ver sección del pipeline de fotos de góndola más abajo), un set completo de tablas nuevas que respaldan justo lo que acá se decía que no existía:

- `RETSC_OP_RETAILER` (`Retailer_id`, `Retailer_dsc`, `Supermarketchain_id`, `Formato`, `Ejecutivo_asignado`, `Zona`, `Canal`, lat/long...) — el catálogo de tiendas que "Tiendas activas" necesitaba.
- `RETSC_OP_PLANOGRAM` (`Enterprise_id`, `Category_id`, `Retailer_id`, `Planogram_seq`, `Up_date`/`Down_date`, `Status`, `URL_picture`...) — Planogramas.
- `RETSC_OP_ASSORTMENT` (`assortment_id`, `enterprise_id`, `category_id`, `sku_id`, `is_mandatory`, `priority`...) — Surtido.
- `RETSC_EX_VISIT` (`Visit_id`, `User_id`, `Enterprise_id`, `Retailer_id`, `Visit_start`/`Visit_end`, lat/long, `Status`...) — Visitas de campo.
- `RETSC_EX_KPI` (`kpi_id`, `photo_id`, `visit_id`, `planogram_sku_id`, `status_compliance`, `facings_eval`, `compliance_score`...) — KPIs de cumplimiento.
- `RETSC_EX_SHELFPHOTO_DETECTION` (`Detection_id`, `Photo_id`, `EAN`, `Sku_id`, `Confidence`, `Bbox_*`, `ocr_text`...) — detecciones de producto en fotos de góndola, candidato a "Faltantes detectados".

**Las seis estaban vacías (0 filas) y, al momento de esa nota (2026-07-26), ningún archivo de este repo las leía ni las escribía todavía** (verificado con `grep` sobre `src/`) — el esquema existía, pero no había ningún servicio/repo/ruta conectado a él.

✅ **Actualización — guía "Fotos de Visita" v1.9 (María Royo, julio 2026):** la guía fue el pedido explícito del equipo que esta nota pedía antes de tocar "Visitas"/"Faltantes detectados". Ver la sección "Visit-based shelf photo pipeline" más abajo para el flujo completo implementado a partir de esa guía (migración `010_create_visit_photo_pipeline.sql` — renumerada desde `008` al fusionar con `developo-Joe`, que ya usaba los números `008`/`009` para el esquema del dashboard). Cuatro de las seis tablas ya tienen repositorio propio hoy — `retailerRepo.js`, `visitRepo.js`, `assortmentRepo.js`, `shelfPhotoDetectionRepo.js` — implementados exactamente para ese flujo; `RETSC_OP_RETAILER` en particular ya se confirmó existente con columna `Canal` tal como asumía la guía (sigue vacía, 0 filas). Quedan sin código: `RETSC_OP_PLANOGRAM` (Planogramas) y `RETSC_EX_KPI` (KPIs de cumplimiento) — la regla de "no inventar endpoints para esto sin pedido explícito" se mantiene igual para esas dos.

⚠ **Actualización (2026-07-29, dump completo de schema vs. `sqldb-rscope-qa`)**: la premisa "no hay tabla de retailers" **ya no es cierta contra QA** — ver `docs/DB-SCHEMA.md`. QA sí tiene `RETSC_OP_RETAILER`, `RETSC_OP_SMKTCHAINS`, `RETSC_OP_SMKTFORMATS`, `RETSC_OP_PLANOGRAM`, `RETSC_OP_PLANOGRAMDET`, `RETSC_EX_VISIT`, `RETSC_EX_KPI` y `RETSC_OP_ASSORTMENT`, todas con FKs coherentes pero **0 filas** (schema presente, sin datos ni endpoints todavía). No se sabe si `sqldb-rscope-prod` tiene el mismo schema — las notas de "fuera de alcance" de arriba se verificaron solo contra prod (2026-07-1). Antes de construir sobre estas tablas, confirmar con el equipo si esto fue una adición deliberada a QA y si prod las tiene o las tendrá. No hay decisión de equipo todavía — no empezar endpoints de GERENCIA solo por este hallazgo.

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
              └─► checkAndUpdateThreshold() → auto-trains + auto-publishes when threshold hit
                  (cableado 2026-08-03, spec v1.4 — see "Entrenamiento de modelos" below)
```

Key files: `src/services/shelfPhotoUploadService.js` (orchestrator), `src/services/shelfPhotoQualityService.js` (pixel quality gate, mirrors `imageValidationService.js` used by the SKU pipeline), `src/services/azureVisionService.js` (stub — see below), `src/services/annotationService.js` + `src/repositories/annotationRepo.js`, `src/services/annotationSyncService.js` (Custom Vision region sync, Issue 8.2 — see below), `src/services/modelVersioningService.js` (reduced to read-only listing, see below), `src/services/modelTrainingService.js` (Custom Vision training + polling logic, preserved but no longer reachable via HTTP — see "Entrenamiento de modelos" below).

`src/services/azureVisionService.js` is a **stub**: `isConfigured()` checks `AZURE_VISION_ENDPOINT`/`AZURE_VISION_KEY`, but `analyzeCaption()` and `isShelf()` always return permissive stub results regardless — the real SDK (`@azure-rest/ai-vision-image-analysis`) is not installed yet, only TODO'd.

⚠ **Schema split 2026-07-26 (DBA migration)** — the DBA team moved every photo-level field out of `RETSC_AI_TRAINING_ANNOTATIONS` into a **new table**, `RETSC_AI_TRAINING_PHOTOS` (one row per uploaded photo; real FK `FK_ANNOTATION_PHOTO`: `RETSC_AI_TRAINING_ANNOTATIONS.photo_id` → `RETSC_AI_TRAINING_PHOTOS.photo_id`). This broke the review queue with `Invalid column name 'photo_approved'` (and, less visibly, also broke single-annotation `approve`/`correct` and `updateCvSync`, which referenced the same moved columns) until fixed the same day — see `src/repositories/trainingPhotoRepo.js`'s header for the full column list and the fix. Key points:
- `RETSC_AI_TRAINING_ANNOTATIONS` now holds **only bounding boxes**: `annotation_id` (PK), `photo_id`, `bbox_left/top/width/height` (float, normalized 0–1), `source`, `is_validated` (bit), `created_at`, `cv_region_id`. No more `dtc_category_id`, `canal`, `photo_approved`, `photo_notes`, `photo_reviewer_id`, `photo_reviewed_at`, `cv_sync_status/error/attempts` — those live on `RETSC_AI_TRAINING_PHOTOS` now (see below).
- **`RETSC_AI_TRAINING_PHOTOS`** (new): `photo_id` (PK), `uploaded_by_user_id`, `uploaded_by_enterprise_id` (nullable), `category_id`, `canal` (CHECK: `OMT`|`DTT`|`CONVENIENCE`), `blob_path`, `photo_status` (CHECK: `EN_PROGRESO`|`LISTA_PARA_REVISION`|`APROBADA`|`RECHAZADA` — note the Spanish values; the API still accepts/returns the old English names `PENDING_ANNOTATION`/`PENDING_REVIEW`/`APPROVED`/`REJECTED`, mapped internally in `trainingPhotoRepo.js`), `reviewer_id`, `reviewed_at`, `photo_notes` (still carries the embedded `cvImageId:` convention), `cv_sync_status`/`cv_sync_error`/`cv_sync_attempts`, `created_at`. **Distinct from `RETSC_EX_SHELFPHOTO`** — no FK between them, separate `Photo_id`/`photo_id` namespaces; `RETSC_EX_SHELFPHOTO` still exists for the hash/quality dedup columns from migration 005 and is untouched by this split.
- `shelfPhotoUploadService.js`'s upload flow (Etapa 7) now inserts into `RETSC_AI_TRAINING_PHOTOS` and creates **zero** annotation rows at upload time (no cajitas exist yet — those come from the annotation team, Issue #42, external, not in this repo). `annotationRepo.insert()` (real bbox creation) has no caller today, kept ready for when #42 lands.
- `trainingPhotoRepo.listPhotos()`/`getPhotoWithRegions()`/`approvePhoto()` replace the same-named functions that used to live in `annotationRepo.js` (moved wholesale — they're photo-level concerns now). `annotationController.js`'s `listPhotos`/`getPhotoDetail`/`approvePhoto` call the new module; the JSON response shape did not change (`dtc_category_id`/`photo_approved` are aliases computed from `category_id`/`photo_status` to avoid a frontend break).
- Approving a photo is now two updates across two tables: `trainingPhotoRepo.approvePhoto()` (sets `photo_status='APROBADA'` + `reviewer_id`/`reviewed_at`) and `annotationRepo.validateAllByPhoto()` (sets `is_validated=1` on all its boxes) — the controller calls both. A photo with zero annotations is a valid state now (freshly uploaded, no boxes yet) — the 404 check in `approvePhoto` is based on the photo existing, not on annotation count (that distinction didn't exist before the split, since upload used to always create one placeholder annotation).
- A photo cannot be left with zero annotations via the single-annotation reject flow — `annotationService.reject()` still returns 409 if it's the last one for that photo (this rule is unaffected by the split).
- `annotationRepo.approve()`/`correct()` (single-bbox actions) no longer persist a reviewer/timestamp — those columns don't exist at the bbox level anymore; only `is_validated` is set. The `reviewerId` parameter is kept in the function signature for call-site compatibility but is unused.
- `annotationSyncService.js` was rewritten to fetch the photo row (`trainingPhotoRepo.findById`) separately from the annotation rows (`annotationRepo.listByPhoto`) instead of reading `category_id`/`canal`/`photo_notes` off the (now nonexistent) annotation-level columns. `cv_region_id` (per-box) updates go through the new `annotationRepo.updateCvRegionId()`; `cv_sync_status`/`error`/`attempts` (now per-photo, not per-box) go through `trainingPhotoRepo.updateCvSync()`.
- **Known follow-up, not fixed as part of this pass**: `scripts/test-annotation-review.js` still assumes the pre-split schema (inserts/reads the old moved columns directly against the DB) and will need updating before it's trusted again. (`scripts/test-model-versioning.js` — the other script with this issue — was deleted entirely 2026-08-03, see below; it tested a flow that no longer exists.)

`RETSC_EX_SHELFPHOTO` gained quality/dedup columns via migration 005 (`image_hash`, `quality_status`, `quality_error_code`, `width`, `height`, `blur_score`, `brightness`); unique filtered index on `(ENTERPRISE_ID, image_hash)`.

`RETSC_AI_DETECTION_MODELS` gained monitoring-only metrics columns via migration 006 (`precision_score`, `recall_score`, `mean_ap`, `metrics_json`) — **aplicada contra `sqldb-rscope-prod` 2026-08-04** (verificado antes/después con `INFORMATION_SCHEMA`; las 2 filas existentes quedaron con las 4 columnas nuevas en `NULL`, ninguna otra columna/fila se tocó). ⚠ **2026-08-03 (decisión de jefatura)** — la migración 006 originalmente también agregaba `approved_by`/`approved_at` para un flujo de aprobación humana manual (`modelVersioningService.js` gestionaba un ciclo completo de re-entrenamiento con gate de métricas). Todo ese flujo fue **eliminado por completo** (no solo desactivado): `approveVersion`/`rejectVersion`/`startRetrain`/`completeRetrain`/`canRetrain`/`rollback`/`isWorse` y `aiModelRepo.setApproval()` ya no existen, los endpoints `POST /api/models/:modelId/approve`/`reject`/`complete`, `POST /api/models/category/:categoryId/retrain`/`rollback/:version`, `GET /api/models/category/:categoryId/can-retrain` fueron retirados, y el script de la migración 006 se ajustó (antes de aplicarse) para ya no agregar `approved_by`/`approved_at`. Motivo: la spec v1.4 exige publicación 100% automática, sin gate de métricas ni aprobación humana — ver "Model versioning" y "Entrenamiento de modelos" más abajo para el estado actual (reducido a listados de solo lectura) y `docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md` para el diagnóstico completo que motivó la limpieza.

✅ **Cableado 2026-08-03 (misma tanda, pasada siguiente a la limpieza)** — el flujo automático de la spec v1.4 (fotos aprobadas+sincronizadas → umbral → training → publicación) quedó completamente conectado, reusando exactamente las piezas preservadas arriba: `aiModelRepo.setActiveVersion()` (swap `is_active`+`status='PUBLISHED'` — renombrado desde `'READY'`), `aiModelRepo.saveMetrics()` (solo monitoreo, sin gate), `aiModelRepo.getMaxVersion()` (incremento de `model_version` al publicar), y `modelTrainingService.js` completo (ya no huérfano — ver "Entrenamiento de modelos" abajo). Dos funciones nuevas en `aiModelRepo.js`: `markTrained()` (avanza `trained_at` de forma independiente de `saveMetrics()` — necesario para que el conteo de umbral no dependa de que el guardado de métricas tenga éxito) y `markPublished()` (persiste `model_version`/`last_publish_name` tras una publicación exitosa). Probado contra CV real (tags) y con stubs de `aiModelRepo`/`customVisionService` vía `require.cache` (dispatch/no-dispatch del umbral, y los 3 caminos de publicación: OK, rechazo de red, `predictionResourceId` null) — el `.env` de este repo apunta a `sqldb-rscope-prod`, así que la lógica se validó sin tocar la BD real.

Role gates (CSV env vars, all default to `ADMIN,ADMIN_DTC`): `ANNOTATION_VALIDATOR_ROLES` for approve/correct/reject, `SHELF_UPLOAD_ROLES` for photo upload, `MODEL_MANAGER_ROLES` for the two remaining read-only `/api/models` routes. `TRAINING_ADMIN_ROLES` is unused since 2026-08-03 (gated the now-removed manual training endpoint).

### Sincronización de anotaciones a Custom Vision (Issue 8.2)

`src/services/annotationSyncService.js` **no expone ruta HTTP propia**: es la interfaz acordada con el disparador de aprobación del cliente (Issue #54, construido por otra persona, todavía no integrado en este repo). Dos puntos de entrada:

- **`syncApprovedPhoto(photoId, { clienteAjustoCajitas })`** — se debe llamar inmediatamente después de que algo setee `photo_status='APROBADA'` en `RETSC_AI_TRAINING_PHOTOS` (columna renombrada/movida el 2026-07-26 — antes era `photo_approved=1` en la tabla de anotaciones). Si `clienteAjustoCajitas === false` no se toca Custom Vision (las cajitas ya estaban sincronizadas de una corrección previa); en cualquier otro caso se borran las regiones viejas y se recrean todas las cajitas actuales de la foto — el tag de cada región se resuelve vía `customVisionService.ensureTag(projectId, canal)` (cableado 2026-08-03, ver más abajo). Luego siempre corre `checkAndUpdateThreshold`, que desde 2026-08-03 puede disparar un entrenamiento automático (ver sección "Entrenamiento de modelos"). **Desde 2026-07-25 tiene DOS disparadores**: el Issue #54 original (externo, sigue sin integrarse) y `PATCH /api/annotations/photos/:photoId/approve` (menú por rol, Pending Work #10). Si #54 se integra más adelante, decidir cuál de los dos llama a `syncApprovedPhoto` para la misma foto — no debería ser ambos. No es urgente: `syncRegionsForPhoto` ya es idempotente por `cv_region_id` (`splitByCvRegionId`), así que una doble llamada no duplica regiones en Custom Vision, solo generaría llamadas HTTP redundantes.
- **`removeRejectedPhoto(photoId)`** — borra las regiones (y la imagen) en Custom Vision pero **conserva la fila en SQL** — el issue pide no borrar registros.

Ninguna de las dos lanza por fallos de Custom Vision — la aprobación/rechazo ya quedó persistida en SQL antes de llamarlas y no debe revertirse por un problema de sincronización; los fallos se registran en `cv_sync_status='ERROR'` / `cv_sync_error` / `cv_sync_attempts` (columnas en `RETSC_AI_TRAINING_PHOTOS`; renombrado de `'FAILED'` a `'ERROR'` 2026-08-03 para alinear con la spec v1.4 — verificado que ningún filtro/consulta dependía del literal viejo) para reintento manual.

Issue #35 (tag por canal — env vars globales `CV_TAG_*` incorrectas con más de un proyecto CV activo) **resuelto 2026-08-03**: `resolveTagId(projectId, canal)` ahora resuelve/crea el tag on-demand DENTRO del proyecto de la categoría vía `customVisionService.ensureTag()` (lista tags del proyecto, reusa por nombre exacto si existe, crea si no) — nombre del tag = el canal solo (`'OMT'`/`'DTT'`/`'CONVENIENCE'`), sin componer con la categoría (el proyecto CV ya es la categoría). Probado contra CV real: dos fotos del mismo canal reusan el mismo tag id, canales distintos generan tags distintos.

Dos decisiones no obvias documentadas en el header del archivo:
- El `cvImageId` de una foto viaja embebido en el texto libre `photo_notes` (formato `"blob:... | sha256:... | cvImageId:..."`, escrito por `shelfPhotoUploadService`) — **no tiene columna propia** (TEMPORAL).
- Custom Vision no devuelve un ID de correlación al crear regiones y **no preserva el orden de envío** — `createImageRegions()` se correlaciona por coordenadas (`coordsMatch()`, tolerancia `1e-6`). Dos cajitas con coordenadas idénticas en la misma foto hacen que Custom Vision rechace el batch entero (`400 Duplicate image regions`), lo que marca la foto entera como `cv_sync_status='ERROR'`, no solo las cajitas duplicadas.

⚠ **Bug conocido sin corregir** (`docs/BUG-is_active-no-unico.md`): nada en la BD impide más de una fila `is_active=1` para la misma `category_id` en `RETSC_AI_DETECTION_MODELS` — no hay constraint ni índice único filtrado. `aiModelRepo.findByCategoryId()` (usado por `annotationSyncService`, `modelTrainingService.startTraining()` y `shelfPhotoUploadService`) simplemente toma `recordset[0]` si eso llega a pasar, sin garantía de cuál fila devuelve. Ya causó un incidente real en pruebas contra producción (`category_id=36`). Con el flujo automático ya cableado (2026-08-03), este bug afecta directamente qué modelo recibe el disparo de training/publicación si alguna vez hay más de una fila activa — sigue sin resolverse, requiere decisión de equipo (índice único filtrado vs. transacción explícita).

### ⚠ Desconexión con el equipo de anotación (#42, Arthur) — narrativa actualizada 2026-08-08, endpoint propio ya existe

**Diagnóstico original (2026-08-05)**: `photo_id=1` apareció con `uploaded_by_enterprise_id=37` (no-NULL) y `photo_notes=NULL`, combinación que en ese momento parecía imposible de producir por `uploadShelfPhoto` — se concluyó que #42 escribía directo a Blob/SQL sin pasar por este backend en absoluto, y que `annotationRepo.insert()` no tenía ningún caller.

**Corrección 2026-08-08, tras revisar 3 commits nuevos de Arthur/jimmy (`c1e725b`, `962c6d0`, `9b64923`) que llegaron a `origin/developo-Joe`**: esa lectura ya no es del todo cierta.
- `c1e725b` agrega `POST /api/annotations/photos/:photoId/regions`, que llama a `annotationRepo.insert({photo_id, source:'MANUAL', is_validated:1, bbox_*})` — **`annotationRepo.insert()` ya tiene un caller real**, dejó de ser código muerto. También agrega `GET /api/annotations/photos/:photoId/image` (proxy de blob, evita la expiración de 60 min del SAS), `PATCH /api/annotations/photos/:photoId/complete` y `PATCH /api/annotations/photos/:photoId/reject`.
- La misma tanda corrige `shelfPhotoController.js`/`shelfPhotoUploadService.js` para propagar `enterpriseId` (antes siempre quedaba `NULL`) — esto **explica** el `uploaded_by_enterprise_id=37` de `photo_id=1`: pudo venir de una subida real vía `POST /api/shelf-photos/upload` hecha antes de este fix, no necesariamente de una escritura directa a SQL.
- `962c6d0`/`9b64923` (jimmy) corrigen un bug real en la Etapa 5 de `shelfPhotoUploadService.js`: si el hash de una imagen ya existía para OTRO canal, se reusaba el `blob_path` del canal viejo en vez de subir el archivo al canal correcto — ahora el blob siempre se sube (un archivo por canal), solo el insert de dedup en `RETSC_EX_SHELFPHOTO` sigue siendo condicional.

**Lo que sigue sin explicación**: `photo_notes=NULL` en `photo_id=1` — la Etapa 7 de `uploadShelfPhoto` sigue construyendo `photo_notes` de forma incondicional y no cambió en estos commits, así que un `NULL` ahí no lo explica ninguno de los tres commits nuevos. Lectura más probable: un artefacto de debugging/pruebas manuales de ese mismo período (alguien insertando o editando la fila a mano contra `sqldb-rscope-prod` mientras probaba), no evidencia de un bypass sistemático vigente. No se confirmó con Arthur directamente — si vuelve a aparecer una fila con `photo_notes=NULL` y sin `uploaded_by_enterprise_id`, ahí sí valdría la pena reabrir la hipótesis de escritura directa a SQL.

**La mitigación (Opción C, 2026-08-05) se mantiene igual, y sigue siendo útil independientemente de la causa real**: `annotationSyncService.autoRegisterImage()` — si `syncRegionsForPhoto` no encuentra `cvImageId` en `photo_notes`, descarga el blob (`blobStorageService.downloadFromContainer()`), lo sube a Custom Vision (`createImageFromData()`), y persiste `photo_notes` con el mismo formato que usa `uploadShelfPhoto` (`trainingPhotoRepo.updatePhotoNotes()`). Deja siempre un `console.warn` explícito para que quede rastro de cada vez que ocurre — nunca es silencioso. Sigue siendo la red de seguridad correcta para cualquier foto que llegue al sync sin `cvImageId`, sea cual sea la causa (bypass real, fila manual de debugging, o un caso legítimo aún no identificado).

**Framing revisado sobre la "corrección de fondo"**: ya no está claro que haga falta una "Opción A" de coordinación con Arthur para que #42 empiece a usar el endpoint correcto — el endpoint de creación de anotaciones (`POST /api/annotations/photos/:photoId/regions`) ya existe y ya tiene un caller. Lo que sí vale la pena confirmar con Arthur es si el frontend/canvas del equipo de anotación efectivamente llama a este endpoint nuevo (en vez de seguir escribiendo directo a SQL, si alguna vez lo hizo) — pero eso es una pregunta de seguimiento, no un gap de código conocido en este backend.

**Hallazgo adicional al probar el fix contra `photo_id=1` real (sigue vigente, no afectado por los commits nuevos)**: el auto-registro funcionó (pobló `photo_notes` con un `cvImageId` real), pero el sync de regiones en sí falló con `400 BadRequestImageRegions: Duplicate image regions` — sus 73 "cajitas" resultaron ser solo **5 posiciones de bbox únicas, cada una repetida** (14, 4, 15, 17 y 16 veces). Es el caso borde ya documentado arriba ("Dos cajitas con coordenadas idénticas..."), pero a una escala mucho mayor de lo que ese comentario anticipaba — probablemente un problema del lado del canvas de #42 (¿doble-submit, o un bug generando cajitas repetidas?), no de este backend. **No se corrigió** (no se deduplicaron anotaciones sin autorización explícita) — `photo_id=1` queda con `cv_sync_status='ERROR'` hasta que el equipo decida qué hacer con esos datos.

### Entrenamiento de modelos y publicación automática (Issues 8.3/8.4 — cableado completo 2026-08-03, spec v1.4)

⚠ **RETIRADO 2026-08-03 (decisión de jefatura)**: el endpoint `POST /api/training/models/:categoryId/train` (con `trainingRoutes.js`/`trainingController.js`) fue **eliminado por completo** — no queda ni para pruebas manuales.

✅ **Cableado 2026-08-03 (misma tanda)**: `annotationSyncService.checkAndUpdateThreshold()` es ahora el único disparador de `modelTrainingService.startTraining(categoryId, null)` (el `adminUserId=null` distingue el disparo automático de uno manual en los logs — ya no hay uno manual). El mecanismo:

1. Tras cada sync exitoso de una foto, cuenta `trainingPhotoRepo.countSyncedSinceByCategoryChannel(categoryId, canal, model.trained_at)` para los 3 canales — cuenta fotos con `cv_sync_status='SYNCED'`, y si `trained_at` ya tiene valor, solo las sincronizadas DESPUÉS de esa fecha.
2. **Dos umbrales distintos contra ese mismo conteo (ajuste 2026-08-10, pedido de jefatura)**: si `trained_at IS NULL` (la categoría nunca entrenó), el umbral es `SHELF_TRAINING_THRESHOLD` (fijo en código, default 15 — es el mínimo real de Azure Custom Vision, no un parámetro de negocio, no se lee de `RETSC_CONFIG` a propósito). Si `trained_at` ya tiene valor (reentrenamiento), el umbral es `RETSC_CONFIG.RETRAIN_BATCH_SIZE` (leído vía `configService.getNumberConfig()` — mismo patrón defensivo que `SKU_MATCH_THRESHOLD`: cache 60s, fallback 10 si la fila falta/no parsea, nunca un `CAST` crudo). Antes de este ajuste había un solo umbral (15) aplicado a ambos casos — con el conteo ya acotado "desde `trained_at`", eso obligaba a 15 fotos nuevas para cada reentrenamiento en vez del valor de negocio (10) que jefatura quería. Al llegar cualquier canal al umbral que corresponda: marca `IMAGES_UPLOADED` y llama `startTraining()` fire-and-forget (no bloquea el sync). `startTraining()` entrena el **proyecto CV completo** (`trainProject()` no es por-tag), cumpliendo "20 OMT + 15 DTT → entrena con las 35" de la spec.
3. El guard de re-disparo es SOLO `status==='TRAINING'` (`SKIP_THRESHOLD_STATUSES`) — deliberadamente NO incluye `IMAGES_UPLOADED` (evita que un modelo quede atascado si algo más, como la Etapa 8 de `shelfPhotoUploadService.js`, ya lo marcó así sin entrenar) ni `PUBLISHED`/`READY` (un modelo publicado debe poder re-entrenarse; el conteo "desde `trained_at`" ya evita re-disparar con las mismas fotos).
4. Al completar (`Completed` en CV), `modelTrainingService.handleTrainingCompleted()` guarda métricas (solo monitoreo, sin gate), llama `aiModelRepo.markTrained()` (avanza `trained_at` SIEMPRE, incluso si `saveMetrics()` falla por cualquier motivo — necesario para que el conteo del punto 1 no quede roto), marca `status='TRAINED'`, y llama a `publishAndActivate()`:
   - Resuelve `predictionResourceId` (de `model.prediction_resource_id`) y arma `publishName = v{versión}-{fecha}`.
   - Llama `customVisionService.publishIteration(..., { overwrite: true })`.
   - **Si publica OK**: `aiModelRepo.markPublished()` (incrementa `model_version`, guarda `last_publish_name`) + `aiModelRepo.setActiveVersion()` (swap `is_active` + `status='PUBLISHED'`, renombrado desde `'READY'`).
   - **Si falla** (Resource ID null, o Custom Vision rechaza el Resource ID — ver bloqueantes de Azure abajo): el modelo queda en `TRAINED` (entrenado, no publicado), se loguea la razón con claridad, y NO se hace ningún swap parcial. Sin reintento inmediato — el próximo ciclo de entrenamiento (siguiente +15 fotos) reintenta con el mismo mecanismo, sin cambios de código, en cuanto el Resource ID correcto esté configurado.

✅ **Los dos bloqueantes de Azure para la publicación — RESUELTOS 2026-08-04** (ninguno era de código, ambos confirmados end-to-end contra Custom Vision real):
1. `prediction_resource_id` se guardaba `NULL` porque el Resource ID de ARM real (157 caracteres) excedía el `VARCHAR(100)` de la columna (BUG 2026-07-19). Jefatura amplió la columna a `VARCHAR(200)`; `aiInfrastructureService.getSafePredictionResourceId()` (ahora `PREDICTION_RESOURCE_ID_MAX_LENGTH=200`) y los bindings `sql.VarChar(...)` de `aiModelRepo.js` (`insert`/`updateCustomVisionRefs`) se ajustaron al nuevo tamaño; las 2 categorías existentes (`category_id=5,6`) se re-poblaron manualmente con el valor completo vía `updateCustomVisionRefs()`.
2. El `BadRequestInvalidPublishTarget` que devolvía Custom Vision (probado 2026-08-03) resultó ser el mismo problema del punto 1, no un recurso equivocado: el `.env` tenía el Resource ID **truncado** (le faltaba `/accounts/{nombre}`). Con el valor completo, `publishIteration` publica sin error — probado en vivo entrenando una iteración real en un proyecto CV descartable.

Probado (sin tocar la BD real de `sqldb-rscope-prod` para la lógica de dispatch — stubs vía `require.cache`, mismo patrón que `scripts/test-user-role-gates.js`; el fix del Resource ID sí se probó contra CV y BD reales): dispatch al llegar al umbral, no-dispatch por debajo, skip mientras `TRAINING`, no-bloqueo por `PUBLISHED`/`READY` viejo, los 3 caminos de `publishAndActivate` (OK mockeado, rechazo de red simulado, `predictionResourceId=null` con la guardia REAL de `publishIteration`), y la publicación real con el Resource ID corregido. Ver `docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md` para el diagnóstico que motivó este cableado.

Antes de retirarse, el endpoint solo validaba `status='IMAGES_UPLOADED'` (409 en cualquier otro estado) y que el modelo tuviera `customvision_project_id` antes de llamar a `startTraining()` — esa misma guardia de estado sigue viva dentro de `startTraining()` sin cambios; el único caller hoy es `checkAndUpdateThreshold()` (ver arriba), que ya deja el modelo en `IMAGES_UPLOADED` antes de llamar.

`modelTrainingService.startTraining()` sigue siendo fire-and-forget: llama a `customVisionService.trainProject()`, marca `status='TRAINING'`, y lanza `pollTrainingStatus()` **sin await** en background dentro del mismo proceso Node (consulta cada 30s, hasta 40 intentos = 20 min de timeout de seguridad, se rinde tras 3 fallos de red consecutivos). El progreso se consulta con `GET /api/models/category/:categoryId` (Issue 8.5).

**Limitación conocida**: el polling vive en memoria del proceso — si el server se reinicia a mitad de un entrenamiento, el polling se pierde y el modelo queda "colgado" en `TRAINING` (Custom Vision sigue entrenando del lado de Azure, pero nadie vuelve a consultarlo). No hay lógica de reanudación al arrancar (a diferencia de `jobRepo.failStaleRunning` en `app.js`) — TODO fuera de alcance de este cableado; hoy el modelo queda atascado en `TRAINING` hasta que se acumulen más fotos y el propio umbral (que no bloquea por `TRAINING` para siempre, solo mientras esté activo) permita un reintento eventual, o se reinicie manualmente vía script.

✅ **Migración 006 aplicada contra `sqldb-rscope-prod` (2026-08-04)** — las columnas `precision_score`/`recall_score`/`mean_ap`/`metrics_json` ya existen; `aiModelRepo.saveMetrics()` funciona. `handleTrainingCompleted()` sigue envolviendo ese llamado en try/catch de todas formas (defensivo, no porque falte la migración) para que un fallo de guardado de métricas nunca impida pasar a `TRAINED` ni bloquee la publicación — `aiModelRepo.markTrained()` avanza `trained_at` independientemente de este try/catch (ver más arriba).

### ⚠ Hallazgo real 2026-08-08 — `category_id=2` con 15 fotos SYNCED no dispara training: Custom Vision rechaza con "Not enough images per tag" aunque cumple el mínimo documentado

Jefatura aprobó 15 fotos góndola de `category_id=2` (canal OMT) esperando el disparo automático. Investigación completa (varias pasadas de diagnóstico contra CV real, no solo contra la BD):

- **Descartado, no era el problema**: no había "regiones fantasma" — se verificó 1:1 contra Custom Vision (no solo contra SQL) que las 722 cajitas de las 15 fotos tienen `cv_region_id` reales, correctamente tageados, coincidiendo exactamente con lo que CV devuelve. `annotationRepo.updateCvRegionId()` (único writer de `cv_region_id`) solo se llama desde `markSynced()`, y esa solo se llama DESPUÉS de que `createImageRegions()` confirma las regiones — el código nunca marca `cv_region_id` de forma especulativa. `SYNCED` ya significa correctamente "imagen + regiones reales confirmadas", no hizo falta tocar ese mecanismo.
- **Sí era un problema real, y se corrigió**: el proyecto CV de `category_id=2` tenía un tag `DTT` con `imageCount=1` — resultó ser la MISMA imagen real de `photo_id=1` con un tag extra incorrecto (no una imagen huérfana separada), residuo de pruebas de una pasada anterior de esta sesión contra este mismo proyecto. Se limpió: se removió el tag `DTT` de esa imagen (sus 72 regiones reales quedaron intactas) y se borraron 2 imágenes sin tag/sin regiones (residuo de pruebas, sin fotos reales asociadas). Proyecto verificado limpio: `OMT: 15/15`, `DTT: 0`, `untagged: 0`.
- **Causa real confirmada al reintentar el training real (`trainProject`) tras la limpieza**: Custom Vision sigue rechazando con un error DISTINTO al que se venía asumiendo en diagnósticos previos de este mismo hilo (`BadRequestTrainingNotNeeded`, nunca confirmado con un error real observado) — el error real y confirmado es:
  ```
  400 BadRequestDetectionTrainingValidationFailed: "Not enough images per tag for training"
  ```
  con **exactamente 15 imágenes tageadas y con regiones** bajo el único tag activo (`OMT`). El límite oficial documentado por Microsoft (`limits-and-quotas`) dice "Min labeled images per Tag, Object Detection: 15 (50+ recommended)" — pero en la práctica, con exactamente 15, CV igual rechaza el training. La guía oficial de "Build an object detector" es más clara al respecto: *"As a minimum, you should use **at least 30 images per tag** in the initial training set"* — es decir, 15 es un piso técnico/de cuota (cuántas imágenes se te permite tener), pero el validador interno de training parece exigir más para considerar que "hay suficiente" (probablemente por el split interno de entrenamiento/validación que hace CV). No se encontró ninguna otra causa (se revisaron bboxes degenerados/fuera de rango — ninguno; tags huérfanos — ya limpiados; duplicados de coordenadas — ninguno en estas 15 fotos).
- **Conclusión de negocio, no de código**: la regla "15 fotos primero" de María **no alcanza en la práctica** para que Custom Vision entrene, aunque cumpla el mínimo documentado al pie de la letra. Hace falta **más volumen real por canal** (la guía oficial sugiere 30+) antes de que `category_id=2` pueda entrenar — o el equipo puede optar por subir el umbral de negocio. No se fabricaron datos de entrenamiento falsos para forzar el conteo.

**Fix de robustez implementado (2026-08-08, separado del hallazgo de datos de arriba)** — el "fallo silencioso" que hacía que este problema pasara desapercibido (el modelo quedaba en `IMAGES_UPLOADED` para siempre, sin ningún rastro en BD del motivo real, solo un `console.error` que se pierde en los logs del proceso):
- Nueva columna `RETSC_AI_DETECTION_MODELS.last_training_error VARCHAR(500)` — migración `migrations/009_add_last_training_error_to_detection_models.sql`, **escrita pero NO aplicada todavía contra `sqldb-rscope-prod`** (pendiente de que el equipo la corra manualmente por SSMS, mismo criterio que las migraciones 005-008).
- `aiModelRepo.markTrainingFailed(id, mensaje)` (nueva) — pasa el modelo a `status='TRAINING_FAILED'` y persiste el mensaje real de Custom Vision. Se llama desde `modelTrainingService.startTraining()` si `trainProject()` rechaza (el caso de `category_id=2` de arriba), y desde los 3 puntos de `pollTrainingStatus()` que antes solo hacían `updateStatus(..., 'TRAINING_FAILED')` sin guardar el motivo (iteración `Failed`, demasiados fallos de red consecutivos, timeout de seguridad).
- `aiModelRepo.setTrainingError(id, mensaje)` (nueva) — variante que NO cambia el `status` (para cuando el training sí completó pero la publicación falla — el modelo debe seguir en `TRAINED`, no pasar a `TRAINING_FAILED`); usada en `publishAndActivate()`.
- Ambas funciones degradan igual que `aiModelRepo.saveMetrics()` con la migración 006 (si la columna no existe, la query lanza "Invalid column name" y el caller lo atrapa con un `console.error` adicional, sin romper el flujo) — mientras la migración 009 no se aplique, el comportamiento es idéntico al de antes (silencioso), no hay riesgo de romper nada por no aplicarla todavía.
- `markTrained()`/`markPublished()` ahora limpian `last_training_error` a `NULL` en cada éxito — la columna representa "motivo del último fallo conocido", no un historial.
- `TRAINING_FAILED` sigue sin estar en `SKIP_THRESHOLD_STATUSES` (`annotationSyncService.js`), así que el reintento automático en el próximo sync exitoso sigue funcionando sin cambios adicionales.

**Mensaje sugerido para avisar a jefatura** (el usuario pidió un mensaje para sus jefes en vez de aplicar la migración ahora mismo):

> `category_id=2` no entrena porque Custom Vision rechaza el training con "Not enough images per tag for training" aunque ya tiene exactamente 15 fotos/regiones válidas en el canal OMT (el mínimo que documenta Microsoft). La guía oficial de Microsoft para crear un detector de objetos recomienda **al menos 30 imágenes por tag** como punto de partida real — en la práctica, 15 es insuficiente para que el entrenamiento se acepte. Hace falta subir más fotos reales de góndola para ese canal (o revisar si el umbral de negocio de "15 primero" debería subirse) antes de que el entrenamiento automático pueda completar. Aparte, ya dejamos listo (código armado, falta aplicar una migración de BD) que la próxima vez que Custom Vision rechace un training, el motivo quede guardado en la base de datos en vez de perderse en los logs del servidor — así no hace falta repetir esta investigación manualmente cada vez.

### ⚠ `category_id=2` — de `TRAINED` a `PUBLISHED` (2026-08-10): dos gaps de diseño reales, no hipotéticos

Tras subir más fotos, `category_id=2`/OMT sí llegó a entrenar (15 fotos suficientes esta vez) y el ciclo automático (`checkAndUpdateThreshold` → `startTraining` → `pollTrainingStatus` → `handleTrainingCompleted`) corrió solo hasta el final — **excepto la publicación**, que quedó en `TRAINED` sin pasar a `PUBLISHED`. Investigar por qué expuso dos gaps de diseño distintos, ambos reales (no teóricos):

**Gap 1 — un modelo `TRAINED` no se reconcilia/republica solo.** Causa puntual de este caso: `prediction_resource_id` de `category_id=2` se guardó truncado (122 de 157 caracteres — el `.env` no tenía todavía el sufijo `/accounts/{nombre}` cuando esta categoría se provisionó, 2026-08-05; la columna/guard/bindings ya estaban en `VARCHAR(200)` desde el 2026-08-04, así que esto fue un dato residual de ese momento puntual, no un bug de código vigente — confirmado que una categoría provisionada hoy se guardaría completa). Corregido el dato (`UPDATE` puntual re-poblando el valor completo), pero **eso solo no alcanzó**: no existe ningún watcher/cron/chequeo al bootear que revise modelos `TRAINED` y reintente publicarlos — `publishAndActivate()` solo se llama una vez, desde `handleTrainingCompleted()`, al terminar un training. Cualquier motivo que deje un modelo en `TRAINED` sin publicar (resource id inválido en ese momento, reinicio del proceso a mitad del poll, fallo de red puntual en `publishIteration`) lo deja ahí **hasta el próximo ciclo de entrenamiento completo** (+20 fotos), no antes. Recomendación (no implementada): un endpoint manual de "reconciliar/publicar modelo entrenado" o un chequeo al bootear que compare `TRAINED` + resource id ya válido y reintente sin exigir re-entrenamiento.

**Gap 2 — publicación manual directa en CV desincroniza SQL, y el código no lo detecta.** Al intentar publicar la iteración con el resource id ya corregido, Custom Vision respondió `400 BadRequestIterationIsPublished: "Iteration is already published as: Iteration2"` — la iteración **ya estaba publicada de verdad en CV**, con el resource id correcto, pero SQL nunca se entró (alguien publicó directo contra la API/portal de CV, fuera de este backend). `overwrite:true` no sirve para este caso — ni para republicar bajo el mismo nombre ni bajo uno nuevo; CV exige un `unpublish` explícito primero (`DELETE .../iterations/{id}/publish`, **no implementado** en `customVisionService.js`) antes de aceptar cualquier publish nuevo sobre una iteración ya publicada. Se resolvió reconciliando SQL a mano con la realidad ya confirmada en CV (`saveMetrics()` con las métricas reales, `markPublished(modelId, {modelVersion:2, lastPublishName:'Iteration2'})` — usando el nombre que CV *ya tenía*, no uno nuevo — y `setActiveVersion()`), sin volver a tocar CV. Recomendación (no implementada): antes de intentar `publishIteration`, chequear si la iteración ya tiene `publishName` seteado (`getIteration()` ya lo devuelve) y, si lo tiene, reconciliar SQL con ese valor real en vez de intentar publicar de nuevo y solo enterarse por el error 400.

**Métricas reales guardadas, no las supuestas**: la iteración publicada tiene `precision=0, recall=0, mAP=23.7%` (`RETSC_AI_DETECTION_MODELS.metrics_json`/`mean_ap` de `category_id=2`) — probablemente por entrenar con apenas 15 fotos (recordar la recomendación de Microsoft de 30+ por tag, sección anterior). El modelo quedó `PUBLISHED`/`is_active=1` de todas formas — en esta fase beta lo que se valida es que el pipeline cierra de punta a punta, no la calidad del detector — pero **no es un detector confiable todavía**; no tratarlo como tal sin re-entrenar con más volumen real.

### Smart category AI infrastructure (Issue 3.1.1)

When a category is created or updated with `is_smart_dtc=1`, the system automatically provisions AI infrastructure in background (fire-and-forget, does not block the HTTP response):

```
categoryService.createCategory()
  └─► aiInfrastructureService.provisionForCategory()   [background]
        ├─► blobStorageService.createMarker()           → global-sku-training/dtc-{slug}/.keep
        ├─► blobStorageService.createMarker() × 3        → global-shelf-training/dtc-{slug}/{omt|dtt|convenience}/.keep
        ├─► globalBlobContainerRepo.insert() × 4          → RETSC_INF_GLOBAL_BLOB_CONTAINERS (una fila por prefix)
        ├─► aiModelRepo.insert()                        → RETSC_AI_DETECTION_MODELS (status=PENDING)
        └─► customVisionService.createProject()         → proyecto real si hay credenciales; null si no
```

Key files:
- `src/utils/categoryNameNormalizer.js` — slug generator for blob prefix names (e.g. `"Vino Tinto"` → `"vino-tinto"`)
- `src/services/aiInfrastructureService.js` — orchestrator; never throws, returns `{ status, errors[] }`
- `src/services/customVisionService.js` — **ya no es un stub** (Issue 8.1/8.2/8.3, cerrado 2026-07-19): `createProject()`, `createImageFromData()`, `createImageRegions()`, `deleteImageRegion()`, `deleteImages()`, `trainProject()`, `getIteration()`, `getIterationPerformance()` hacen llamadas HTTP reales a la API v3.3 de Custom Vision Training usando `fetch` nativo (no el SDK oficial — la key de Azure AI Services unificada trae caracteres no-ASCII que el módulo `http` de Node rechaza en headers pero `fetch` acepta). `isConfigured()` sigue siendo el gate para todo el servicio.
- `src/repositories/globalBlobContainerRepo.js` — wraps `RETSC_INF_GLOBAL_BLOB_CONTAINERS`

Blob prefix format: `dtc-{slug}` inside `AZURE_GLOBAL_TRAINING_CONTAINER` (default: `global-sku-training`), más `dtc-{slug}/{omt|dtt|convenience}` inside `AZURE_GLOBAL_SHELF_CONTAINER` (default: `global-shelf-training`) — agregado 2026-07-26, antes `aiInfrastructureService.js` nunca tocaba el container de góndola; esos 3 prefijos quedaban invisibles en el Portal hasta que alguien subía la primera foto real vía `shelfPhotoUploadService.js`. El `.keep` marker file makes the prefix visible in the Azure Portal as a folder.

⚠ **Migración 007 (`007_fix_global_blob_containers_unique.sql`) — aplicada en producción 2026-07-26.** Cambia el UNIQUE constraint de `RETSC_INF_GLOBAL_BLOB_CONTAINERS` de `container_name` solo a `(container_name, prefix)`. Antes, como `container_name` es el mismo valor compartido por todas las categorías de un container, solo la PRIMERA categoría en usar cada container quedaba registrada — el resto chocaba contra el UNIQUE y `aiInfrastructureService.js` atrapaba el error a propósito (para no romper el provisioning real), pero el efecto era que la tabla nunca reflejaba más de 1 fila por container. Con el constraint compuesto, cada categoría (y cada canal, en el caso de góndola) sí queda registrada con su propia fila.

`container_type` (CHK_RETSC_GLOBAL_BLOB_TYPE, solo acepta `'GLOBAL_TRAINING'` o `'GLOBAL_SKU_PHOTOS'`) también estaba hardcodeado mal: `aiInfrastructureService.js` insertaba siempre `'GLOBAL_TRAINING'`, incluso para el container de fotos de SKU. Convención acordada 2026-07-26 (no hay migración/spec previa en este repo que lo defina — es una inferencia por naming, ya que solo existen esos 2 valores para 2 containers): `'GLOBAL_SKU_PHOTOS'` → `global-sku-training`, `'GLOBAL_TRAINING'` → `global-shelf-training`. La fila que ya existía de antes de este fix (SHAMPOO) quedó con el valor viejo (`'GLOBAL_TRAINING'` para el container de SKU) sin corregir — el `UPDATE` de corrección quedó comentado en la migración 007, pendiente de decisión.

### Database tables

`docs/DB-SCHEMA.md` is the canonical, auto-generated map of every real table in the connected DB (columns, types, PKs, FKs, indexes, row counts) — regenerate with `node scripts/dump-schema.js` whenever the schema might have changed, instead of trusting the prose below for tables not yet wired to a repository. The notes below predate that script and were written by hand as each table got its first repo — kept for the narrative/decision context (why a column is nullable, why a join is deliberately avoided) that a raw schema dump can't capture.

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
| `annotationRepo.js` | `RETSC_AI_TRAINING_ANNOTATIONS` (bounding boxes only, since the 2026-07-26 schema split) |
| `trainingPhotoRepo.js` | `RETSC_AI_TRAINING_PHOTOS` (photo-level fields, added 2026-07-26 — see Shelf photo pipeline section above) |
| `visitRepo.js` | `RETSC_EX_VISIT` (new, migration 010 — guía v1.9) |
| `shelfPhotoDetectionRepo.js` | `RETSC_EX_SHELFPHOTO_DETECTION` (new, migration 010) |
| `assortmentRepo.js` | `RETSC_OP_ASSORTMENT` (new, migration 010) |
| `retailerRepo.js` | `RETSC_OP_RETAILER` (existencia confirmada 2026-07-26, tabla vacía — see visit pipeline section) |
| `dashboardRepo.js` | Read-only aggregator (Issue B7) over `RETSC_OP_ENTERPRISE_PRODUCT_SEG`/`RETSC_OP_SKUS`/`RETSC_AI_SKU_FEATURES`/`RETSC_OP_ASSORTMENT` — no table of its own, see the dashboard section below for why each source was picked |
| `configRepo.js` | `RETSC_CONFIG` (2026-08-04, Issue guía v1.9 — ver "Búsqueda de SKU por texto" abajo) |

`userEnterpriseRepo.js` gained `findAllGlobal()` (2026-07-25, F4 menu) — a single JOIN across `RETSC_OP_USRSXENTERP` + `RETSC_OP_USERS` + `RETSC_OP_ROLES` + `RETSC_OP_ENTERPRISE`, used by `userService.listAllGlobal()` (`GET /api/users/global`). Deliberately different from `listByEnterprise`'s N+1 pattern (a `findById` for the user and another for the role per relation) — at global/cross-enterprise scale that N+1 gets expensive fast, and the JOIN's fixed shape (user + role + enterprise, no per-row conditional logic) doesn't need the loop. `listByEnterprise` itself was left as-is (out of scope for this change).

`skuRepo.js` gained `listGlobal(filters)` (2026-07-25, F4 menu) — paginated (`OFFSET`/`FETCH` + `COUNT(*)`) global listing over `RETSC_OP_SKUS`, search by `EAN`/`Product_dsc`, same `buildFilters`-style pattern as `productRepo.listByEnterprise`. Deliberately does **not** JOIN to `RETSC_OP_CATEGORIES` to resolve category names: `selected_category_id` on `RETSC_OP_SKUS` is an FK to `RETSC_OP_ENTERPRISE_CATEGORIES.enterprise_category_id`, not to `RETSC_OP_CATEGORIES.Category_id` (see the SKU ingestion flow section above) — joining it directly against `RETSC_OP_CATEGORIES` would silently show the wrong category description most of the time. Only `detection_category_id` maps directly to `RETSC_OP_CATEGORIES.Category_id`, but it's returned unresolved too, to avoid mixing a correct join with an incorrect one in the same row — the frontend can resolve both IDs via the existing category endpoints if it needs display names.

`skuRepo.js` also gained `listGlobalProducts(filters)` (2026-07-26, F4 menu item "Productos", `GET /api/products/global`) — same paginated pattern, but `GROUP BY` over `RETSC_OP_SKUS` instead of one row per SKU. **There is no FK that defines "product" separately from "SKU"** — `RETSC_OP_PRODUCTS` was dropped (commit `b775f86`) and today one `RETSC_OP_SKUS` row is one EAN. Leadership still wants "Productos" to be a distinct view from "SKUs globales" (one row per EAN, unaggregated), so the grouping key chosen is `(Product_dsc, detection_category_id)` — two EANs with the exact same description **and** the same global/smart category collapse into one product row (e.g. a repackaging that reissues the EAN but keeps the name); same description under a *different* category does not collapse (avoids merging two unrelated products that happen to share descriptive text). Verified against real data (2026-07-26, 3 SKUs, each with a distinct `Product_dsc`) that this grouping doesn't collapse anything yet — the criterion is in place for when duplicate EANs-under-one-name actually occur. `Product_dsc` is nullable in the real schema (though no row is `NULL` today) — grouping directly on it would silently merge every `NULL`-description SKU into one fake product, so the actual `GROUP BY` expression (`PRODUCT_GROUP_KEY_EXPR`) falls back to the SKU's own `SKU_ID` when `Product_dsc IS NULL`, keeping each description-less SKU in its own group. The view never selects any `RETSC_OP_ENTERPRISE_PRODUCT_SEG` column (brand/supplier/client category) — that's what makes it "global"/client-free, unlike `GET /api/products`.

`RETSC_LOG_JOBS` (migration `004_create_jobs_table.sql`) tracks generic async batch jobs — currently only `job_type='SKU_IMAGE_UPLOAD'`. Columns: `job_id` (PK), `user_id`, `enterprise_id`, `job_type`, `status` (`QUEUED → RUNNING → COMPLETED|FAILED`), `total_files`, `processed_count`, `orphan_count`, `duplicate_count`, `error_count`, `warning_count`, `error_summary`, `created_at`, `started_at`, `finished_at`. On server boot, `app.js` calls `jobRepo.failStaleRunning(...)` to mark any job left `RUNNING` from a crash/restart as `FAILED`.

`jobRepo.listByUser()` gained `loadNumber` (Issue B5, 2026-07-26, F5 frontend "Carga #N") — before, the frontend displayed `Carga #{job_id}`, the table's global identity PK, which jumps between unrelated numbers across different enterprises and never starts at 1. `loadNumber` is `CAST(ROW_NUMBER() OVER (PARTITION BY enterprise_id ORDER BY created_at ASC) AS INT)` computed in a subquery (so it doesn't interfere with the outer `ORDER BY created_at DESC` + pagination). **Gotcha hit while building this**: `ROW_NUMBER()` is `bigint` in SQL Server, and the `mssql` driver returns `bigint` columns as JS **strings**, not numbers, by default (precision-safety default) — without the explicit `CAST(... AS INT)`, `loadNumber` silently came back as `"1"`/`"2"` (strings) instead of `1`/`2`. **Known gap, not closed**: this endpoint is user-scoped (`GET /api/sku-images/jobs` — "my uploads", `WHERE user_id = @userId`), so `PARTITION BY enterprise_id` in practice only numbers *this user's* jobs — if two different users of the *same* enterprise both upload, each would see their own counter start at 1 instead of sharing one sequence. No endpoint lists jobs by enterprise (only by user) to fix this properly; flagged, not solved here.

`RETSC_EX_SHELFPHOTO` base columns: `Photo_id` (PK), `Retailer_id`, `Shelfunit_id`, `photo_date`, `URL_blob`, `ENTERPRISE_ID`, `CATEGORY_ID`, `visit_id`. Migration `005_add_quality_fields_to_shelfphoto.sql` adds `image_hash`, `quality_status` (`PASSED`/`REJECTED`), `quality_error_code`, `width`, `height`, `blur_score`, `brightness`, plus a filtered unique index `UX_RETSC_EX_SHELFPHOTO_enterprise_hash` on `(ENTERPRISE_ID, image_hash) WHERE image_hash IS NOT NULL` for per-enterprise dedup. This migration must be applied manually via SSMS, not from Node.

⚠ **Reformulación del DBA — aplicada en vivo contra `sqldb-rscope-prod`, confirmada por `INFORMATION_SCHEMA`/`sys.foreign_keys` el 2026-08-07 (sin migración de este repo — el DBA la aplicó directo, probablemente vía el diseñador de diagramas de SSMS: las 4 tablas involucradas aparecían marcadas con `*` en su captura, que en SSMS significa "cambios sin guardar en el diagrama" en el momento de la foto, ya guardados para cuando se verificó contra la BD real).** Cambios reales verificados:
- **`RETSC_EX_SHELFPHOTO` ganó la columna `User_id` (NOT NULL)** — no existía antes.
- **`Visit_id`, `User_id`, `Enterprise_id`, `Retailer_id` pasaron de nullable a NOT NULL.**
- **`Shelfunit_id` pasó de nullable a NOT NULL.**
- **FK compuesta nueva**: `(Visit_id, User_id, Enterprise_id, Retailer_id)` en `RETSC_EX_SHELFPHOTO` → las mismas 4 columnas en `RETSC_EX_VISIT`. Las 4 deben coincidir exactamente con la fila de la visita — ya no es solo una convención de la app, la BD lo exige.
- **`RETSC_EX_VISIT` ganó dos FKs que antes no tenía**: `(User_id, Enterprise_id)` → `RETSC_OP_USRSXENTERP` (compuesta) y `Retailer_id` → `RETSC_OP_RETAILER`. Esto cierra el hueco de integridad que existía antes (ver historial de este archivo) — pero como consecuencia, **`POST /api/visits` ya no puede abrir ninguna visita mientras `RETSC_OP_RETAILER` siga con 0 filas** (confirmado: sigue vacía en prod) — antes de este cambio la FK no existía y un `Retailer_id` inventado se guardaba sin problema; ahora la BD lo rechaza.
- `visitPhotoService.js`/`shelfPhotoRepo.js` ya se actualizaron para esto (`user_id` se manda siempre, `shelfunitId` pasó a requerido con 400 propio). **TEMPORAL (decisión de Carlos, 2026-08-07)**: el mobile (`RetscApp`) todavía no tiene catálogo/UI de "unidades de anaquel", así que manda un `shelfunitId` fijo en `1` (`TEMPORAL_SHELFUNIT_ID` en `VisitCaptureScreen.js`) para no romper cada subida — no confiar en `Shelfunit_id` de filas reales hasta que el equipo defina la UI real y se reemplace ese placeholder. **`shelfPhotoUploadService.js` (flujo de entrenamiento global, Etapa 5) NO se tocó y hoy está roto por este cambio** — su `shelfPhotoRepo.insert()` nunca mandó `retailer_id`/`user_id`/`visit_id`/`shelfunit_id` (a propósito, es una foto global sin visita) y las 5 columnas ahora son NOT NULL. Pendiente de decisión de equipo: ¿esas fotos globales dejan de insertar en `RETSC_EX_SHELFPHOTO` del todo (ya escriben en `RETSC_AI_TRAINING_PHOTOS` de todas formas, ver arriba) y el hash-dedup se mueve a otro lado, o el DBA agrega una fila "sistema" para poder seguir insertando ahí? No resuelto todavía — no inventar una solución sin que el equipo lo decida, dado que toca una tabla que usan dos flujos distintos.

`RETSC_AI_TRAINING_ANNOTATIONS` columns (post 2026-07-26 schema split — see Shelf photo pipeline section above for the full story and for `RETSC_AI_TRAINING_PHOTOS`): `annotation_id` (PK), `photo_id` (FK → `RETSC_AI_TRAINING_PHOTOS.photo_id`), `bbox_left`, `bbox_top`, `bbox_width`, `bbox_height` (floats normalized to `[0,1]`), `source`, `is_validated` (bit), `created_at`, `cv_region_id`. No `dtc_category_id`/`canal`/`photo_approved`/`photo_notes`/`photo_reviewer_id`/`photo_reviewed_at`/`cv_sync_*` here anymore — those moved to `RETSC_AI_TRAINING_PHOTOS`.

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

Login security: the password check runs before the user-existence check (timing-attack defense). Both "user not found" and "wrong password" return the same generic 401. If a user has multiple active enterprise relations, `authService.pickBestRelation()` picks **ADMIN_DTC first** if any of the active relations has it, otherwise the **oldest** one (`ORDER BY Fecha_activacion ASC, Enterprise_id ASC` in `userEnterpriseRepo.findActiveByUserId`). Users with `Status != 1` or no active enterprise relations are rejected at login.

⚠ **Fixed 2026-07-26 (B2)** — this used to be genuinely broken: `authService.js` picked the relation via `relations.reduce((min, r) => r.Id < min.Id ? r : min, ...)`, but `RETSC_OP_USRSXENTERP` has **no `Id` column at all** (columns are `User_id, Enterprise_id, Role_id, Status, Fecha_activacion, Fecha_inactivacion, Phone` — verified via `INFORMATION_SCHEMA`). `r.Id` was always `undefined`, so `undefined < undefined` was always `false` and the "pick the oldest" rule never actually ran — login/refresh silently returned whichever relation SQL Server happened to return first (no `ORDER BY` existed then), for any user with more than one active enterprise. On top of fixing the ordering, `pickBestRelation()` also now prefers `ADMIN_DTC` over "oldest" — a platform-wide superuser must never end up under-privileged just because that particular enterprise relation happened to be created later than another of their relations. If "wrong role after login" surfaces again for a multi-enterprise user, check `Fecha_activacion` on their relations and whether any of them is `ADMIN_DTC` — those are the real ordering keys now, not a nonexistent `Id`.

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
/api/shelf-photos                  authMiddleware  + requireRole(SHELF_UPLOAD_ROLES) inline on /upload, requireRole(VISIT_ROLES) inline on /visit; GET /unidentified open to any authenticated user (scoped by enterprise in the controller)
/api/visits                        authMiddleware  + requireRole(VISIT_ROLES) inline on all routes (guía v1.9)
/api/sessions                      authMiddleware  — no additional role gate; enterprise scoping enforced in sessionsController.js (both mobile and web/admin roles need to read visit results)
/api/dashboard                     authMiddleware (global) — any authenticated role; scope (own enterprise vs. global) resolved by role inside dashboardService.js, not by middleware
/api/retailers                     authMiddleware (global) — no additional role gate; global PDV catalog, same criteria as /api/categories (added 2026-08-07, mobile map screen — Paso 0 needs a real Retailer_id/lat/lng before opening a visit)
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
| `GET /api/products` | Bearer | Products with pagination/search. `?categoryId=` is free-text `client_category` (footgun, see swagger); `?officialCategoryId=` (added Issue B3, 2026-07-26) is the real numeric FK to `RETSC_OP_CATEGORIES` via `sk.detection_category_id` — deliberately a separate param, not an overload of `categoryId` |
| `GET /api/products/global` | Bearer + `ADMIN_DTC` | Global product catalog (F4 menu, "Productos") derived from `RETSC_OP_SKUS` — no enterprise/client data; grouped by `(Product_dsc, detection_category_id)`, see `PRODUCT_GROUP_KEY_EXPR` in `skuRepo.js`. `?categoryId=` (added Issue B3) filters by `detection_category_id` — no naming clash here since this view has no free-text category concept |
| `GET /api/skus/global` | Bearer + `ADMIN_DTC` | Global paginated SKU catalog listing (F4 menu, "SKUs globales"); search by EAN/`Product_dsc` |
| `POST /api/products/upload-excel` | Bearer | Parse `.xlsx`; returns rows + errors |
| `POST /api/products/upload-images` | Bearer | Up to 200 images → `uploads-temp/<jobId>/` |
| `POST /api/products/process/:jobId` | Bearer | Start async pipeline |
| `GET /api/products/processing-status/:jobId` | Bearer | Poll pipeline state |
| `GET /api/dashboard` | Bearer | Real dashboard metrics (Issue B7), replaces frontend mock data — `productCards`/`productPhotos`/`activeAssortments`/`analysesDone` plus `trends`/`productsByCategory`/`modelPrecision`/`recentActivity` (2026-07-26 follow-up, see Dashboard section below), scoped to the caller's enterprise unless `ADMIN_DTC` (global) |
| `GET /health` | No | `{status, timestamp}` |
| `POST /api/categories/:id/retry-ai-infra` | Bearer + Admin | Reintenta provisioning IA de categoría smart |
| `POST /api/sku-images/upload` | Bearer | Up to 200 images; enqueues a `RETSC_LOG_JOBS` row and returns 202 immediately (see async job flow below) |
| `GET /api/sku-images/jobs` | Bearer | List the authenticated user's SKU-image upload jobs; each job includes `loadNumber` (per-enterprise sequence, Issue B5 — see `jobRepo.js` note above for a known multi-user-per-enterprise gap) |
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
| `POST /api/shelf-photos/upload` | Bearer + `SHELF_UPLOAD_ROLES` | 8-stage quality-gated shelf-photo ingestion (see below) |
| `POST /api/visits` | Bearer + `VISIT_ROLES` | Abre una visita (guía v1.9, Paso 0); `Enterprise_id` sale del JWT |
| `GET /api/visits/:id` | Bearer + `VISIT_ROLES` | Detalle de una visita |
| `PATCH /api/visits/:id/close` | Bearer + `VISIT_ROLES` | Cierra una visita; solo el usuario dueño (o admin) |
| `POST /api/shelf-photos/visit` | Bearer + `VISIT_ROLES` | Sube una foto de VISITA real (Pasos 1-2, guía v1.9); dispara detección en background |
| `GET /api/shelf-photos/unidentified` | Bearer | Productos detectados sin identificar, para el dashboard web (guía v1.9 §8.4); scoped por enterprise |
| `GET /api/sessions/:id/results` | Bearer | Resultados de una visita (guía v1.9, Paso 6): share de góndola + faltantes + sin_identificar; `:id` = Visit_id |
| `GET /api/retailers` | Bearer | Catálogo completo de PDVs (`retailerRepo.list()`, added 2026-08-07) — el mobile lo usa para poblar el mapa de selección de tienda antes de `POST /api/visits`; sin paginar ni scoping (tabla global, hoy 0 filas en prod) |

⚠ **Retirados 2026-08-03 (decisión de jefatura, ver "Model versioning" y "Entrenamiento de modelos" arriba)**: `GET /api/models/category/:categoryId/can-retrain`, `POST /api/models/category/:categoryId/retrain`, `POST /api/models/category/:categoryId/rollback/:version`, `POST /api/models/:modelId/complete`, `POST /api/models/:modelId/approve`, `POST /api/models/:modelId/reject`, y `POST /api/training/models/:categoryId/train` (con el `/api/training` mount completo) ya no existen — no quedó ningún camino manual de re-entrenamiento/aprobación/publicación. El flujo automático de la spec v1.4 que los reemplaza ya está cableado (ver esas mismas secciones).

### Enterprise registration

`POST /api/enterprises` creates an enterprise plus an admin user in one operation. The `type` field must be one of: `"Proveedor"`, `"Detallista"`, `"Empresa de servicios"`. If the admin user already exists by `cédula` with no active relations, the user is reactivated with a fresh generated password instead of creating a new record.

This operation is **not** wrapped in a SQL transaction — it uses manual compensating rollbacks (delete enterprise then delete user) if a later step fails. This is unlike `enterpriseCategoryRepo.js`, which uses an explicit `pool.transaction()`. Be aware of this gap when modifying the registration flow.

Every `409` thrown by `registerEnterprise()`/`createEnterprise()` (duplicate `fiscalId` → `ERR_DUP_FISCAL_ID`, `adminCedula` already active elsewhere → `ERR_CEDULA_ACTIVE_ELSEWHERE`, `adminEmail` belonging to a different user → `ERR_DUP_EMAIL`) carries `{ field, errorCode }` alongside the Spanish `message` (Issue B6, 2026-07-26) — `enterpriseService.js`'s `serviceError(msg, statusCode, { field, errorCode })` attaches them to the error object, `enterpriseController.js`'s `handleError()` spreads them into the JSON body, so the frontend can highlight the exact input without parsing the Spanish text. Scoped to `409`s only — `400` validation/format errors on this flow were left as message-only (matches the acceptance bar this was built against).

### Enterprise status

`RETSC_OP_ENTERPRISE` has a `status` column (lowercase, BIT). Note: unlike other tables in the project that use `Status` (Pascal case), this column is lowercase — always reference it as `row.status` in the repository layer, not `row.Status`.

### Dashboard (`GET /api/dashboard`, Issue B7)

Replaces the frontend's mock dashboard data with real counts, scoped by role: `ADMIN`/`GERENCIA` see their own `enterpriseId`; `ADMIN_DTC` sees the whole platform (`enterpriseId=null` internally). `dashboardService.resolveScope()` does the role check; `dashboardRepo.js` runs the actual counts and never sees a role, only an optional `enterpriseId`.

Source picked for each metric (none were 100% obvious — see `dashboardRepo.js`'s header for the full reasoning):
- **`productCards`** — `RETSC_OP_ENTERPRISE_PRODUCT_SEG` (`status='ACTIVE'`) per enterprise / `RETSC_OP_SKUS` (`status='ACTIVE'`) globally — same "product" definition `productRepo.listByEnterprise` already uses.
- **`productPhotos`** — `RETSC_AI_SKU_FEATURES` (one row per uploaded SKU image), joined to `RETSC_OP_ENTERPRISE_PRODUCT_SEG` for the per-enterprise case.
- **`activeAssortments`** — `RETSC_OP_ASSORTMENT`. This table is real (see the schema-discovery note in "Menú por rol (F4)" above) but has no `status`/`is_active` column, so "active" here means "every row that exists" — there's no soft-delete concept modeled. It's also **empty in production today**, so this metric legitimately returns `0` — that's a real count against a real (if empty) table, not a hardcoded placeholder.
- **`analysesDone`** — `RETSC_OP_SKUS.image_status = 'COGNITIVELY_PROCESSED'` (the SKU-image OCR/embeddings pipeline already marks this — see "SKU image ingestion" below). Deliberately **not** `RETSC_EX_SHELFPHOTO_DETECTION`, despite that table's name sounding like a better fit for "analyses" — it's also newly-discovered, also empty, and **nothing in this repo reads or writes it yet** (it belongs to the not-yet-built GERENCIA/KPI pipeline), so using it would just return `0` forever with no real signal behind it. `image_status` has actual production data behind it today.

Both `resolveScope()`'s treatment of `GERENCIA` (same as `ADMIN` — own enterprise) and the choice of `image_status` over `RETSC_EX_SHELFPHOTO_DETECTION` for `analysesDone` are judgment calls flagged with `// NOTA` in the code for the team to confirm, not settled requirements.

**2026-07-26 follow-up — trends, category breakdown, model precision, recent activity.** The frontend wanted the old mock dashboard's look back: trend arrows/sparklines on the 4 cards, a category donut, a model-precision line, and a recent-activity feed. The response now also carries:

- **`trends.{productCards,productPhotos,activeAssortments,analysesDone}`** — `{ deltaPct, series }` each. Needs a day-over-day history that didn't exist before, so this added a **new table, `RETSC_LOG_DASHBOARD_SNAPSHOTS`** (migration `008_create_dashboard_snapshots.sql`, columns: `snapshot_date`, `scope_enterprise_id` (NULL = `ADMIN_DTC` global scope), the 4 counts, `avg_model_precision_pct`, unique on `(snapshot_date, scope_enterprise_id)`). **Applied manually via SSMS, same convention as migrations 005–007 — never run from Node.** There's no cron in this repo: every `GET /api/dashboard` request upserts *today's* row for its own scope with the numbers it just computed (`dashboardRepo.upsertSnapshotToday`), so history fills in on its own from normal traffic. `deltaPct` compares today against the snapshot nearest 30 days back (or the oldest available); `null` if there's no reference or it's `0` — the frontend hides the arrow rather than showing a fake number. `series` is the last up to 8 snapshots, oldest→newest. **All snapshot reads/writes swallow "Invalid object name" and degrade** (`deltaPct: null`, `series: [todaysLiveValue]`) if migration 008 hasn't been applied yet — confirmed by testing against the real DB before the migration was run.
- **`productsByCategory`** — reuses the exact same source as `productCards` (`RETSC_OP_ENTERPRISE_PRODUCT_SEG` per enterprise / `RETSC_OP_SKUS` globally), grouped by `detection_category_id` instead of counted as one total. Every category with ≥1 product, uncapped (frontend groups the tail into "Otros"); SKUs with no `detection_category_id` bucket under `"Sin categoría"` instead of silently vanishing from the total.
- **`modelPrecision.{avgPct,deltaPct,series}`** — depends on migration 006 (`precision_score` on `RETSC_AI_DETECTION_MODELS`), **applied 2026-08-04** (was pending at the time this dashboard feature was built, hence the defensive `Invalid column name` catch in `getModelPrecisionAvg()` — kept as a harmless no-op safety net now that the migration ran, not because it's still needed). Per-enterprise scope joins through `RETSC_OP_ENTERPRISE_CATEGORIES`'s resolved smart categories (`RETSC_AI_DETECTION_MODELS` has no `enterprise_id` of its own — models are per DTC category, shared across enterprises). Also inherits the known `is_active` non-uniqueness bug (`docs/BUG-is_active-no-unico.md`) — not fixed here, may skew the average. Note: as of 2026-08-04 there are 0 models with `status='PUBLISHED'` in prod, so this metric legitimately returns empty/null until the automatic training/publish flow produces a published model.
- **`recentActivity`** — up to 10 most recent events, merged in JS (not a SQL `UNION`) from 5 independent sources: `RETSC_LOG_JOBS` (`SKU_IMAGES_UPLOADED`), `RETSC_AI_TRAINING_PHOTOS.created_at`/`.reviewed_at` (`SHELF_PHOTO_UPLOADED`/`PHOTO_APPROVED` — **note**: post the 2026-07-26 schema split, the approval timestamp lives on `RETSC_AI_TRAINING_PHOTOS.reviewed_at`, not on the annotations table), `RETSC_OP_ASSORTMENT` (`ASSORTMENT_UPDATED`), `RETSC_AI_DETECTION_MODELS.trained_at` (`MODEL_TRAINED`). Enterprise scoping is exact where a table has a real `enterprise_id`/`uploaded_by_enterprise_id`; shelf-photo events are uploaded as **global** assets by design (`uploaded_by_enterprise_id` is null for real uploads today), so a plain `ADMIN`'s feed will realistically show none of those — expected given the current data model, not a bug.

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
5. **Dedup, PER CANAL (fixed Issue B4, 2026-07-26)** — SHA-256 hash, global scope (`ENTERPRISE_ID IS NULL`) via `shelfPhotoRepo.findByHashGlobal()`, but a hash match only 409s (`ERR_DUPLICATE_IMAGE`) if `trainingPhotoRepo.findByHashAndCanal(hash, canal)` also finds a row for **that same canal** — the same photo can legitimately be uploaded once per channel (OMT/DTT/CONVENIENCE each get their own model). Before this fix, any hash match rejected the upload regardless of canal, so a photo re-used across channels silently never got saved for the second one. `RETSC_EX_SHELFPHOTO` has no `canal` column and `RETSC_AI_TRAINING_PHOTOS` has no `image_hash` column (the hash still travels embedded in `photo_notes`, same convention as `cvImageId`) — neither table has `(hash, canal)` together, so the check crosses both.
6. **Upload, or reuse if the hash already exists for another canal** — to `AZURE_GLOBAL_SHELF_CONTAINER` at `dtc-{categorySlug}/{canal-lowercase}/{filename}`; filename is server-generated (`shelfPhotoFilenameGenerator.js`), never user-supplied. Then insert the `RETSC_EX_SHELFPHOTO` row — **except** when the hash already exists (different canal): `RETSC_EX_SHELFPHOTO` has a filtered unique index `(ENTERPRISE_ID, image_hash)` and SQL Server treats two `NULL` `ENTERPRISE_ID`s as equal for uniqueness purposes (verified empirically against the real DB, 2026-07-26) — inserting the same hash twice with `ENTERPRISE_ID IS NULL` throws a real constraint violation. So a repeat-hash upload reuses the existing blob URL (relative path recovered by stripping the container prefix off the stored URL) instead of re-uploading and re-inserting.
7. **Custom Vision registration (no regions yet)** — looks up the category's `customvision_project_id` via `aiModelRepo`, calls `customVisionService.createImageFromData()` (real upload, implemented 2026-07-19) to get a real `cvImageId` — this still runs even when the blob itself was reused (Custom Vision needs its own image record per canal/project). Then inserts one row into `RETSC_AI_TRAINING_PHOTOS` (see the schema-split note above) with `photo_status='EN_PROGRESO'` — **no** annotation row is created here anymore; bboxes come later from the annotation team (Issue #42, external).
8. **Threshold check** (non-blocking) — if validated+approved annotation count for that category/canal reaches `SHELF_TRAINING_THRESHOLD`, the model's `status` flips to `IMAGES_UPLOADED`.

`shelfPhotoQualityService.assessPhoto()` (a per-enterprise dedup variant, documented in its own file header as the intended entry point) is **dead code** — only the global-scope `validateQualityMetrics()` path above is actually wired to the controller. **This stays dead code even after the visit pipeline below** — that flow deliberately does *not* call `assessPhoto()` either (see its own section for why).

### Visit-based shelf photo pipeline (`/api/visits`, `/api/shelf-photos/visit`, `/api/sessions`, guía "Fotos de Visita" v1.9 — María Royo, julio 2026)

Production flow for the mobile app (auditor/manager in-store), entirely distinct from the training pipeline above: a real field visit, tied to an `Enterprise_id`/PDV/user, producing detections that get matched to actual SKUs and rolled up into a mobile results screen. None of this existed before this guide (confirmed by grepping the whole repo for `visit_id`/`SHELFPHOTO_DETECTION`/`buscarSkuPorTexto` — nothing referenced them) — migration `010_create_visit_photo_pipeline.sql` adds the tables (renumbered from `008` when merging with `developo-Joe`, which already used `008`/`009` for the dashboard schema).

```
POST /api/visits                        (visitService.openVisit)          — Paso 0
  Opens RETSC_EX_VISIT (User_id from JWT, Enterprise_id from JWT, Retailer_id/lat/lon from
  body) → returns Visit_id. No category/canal column on purpose — one visit can span several
  categories; canal is resolved via Retailer_id, never duplicated here (see retailerRepo.js
  caveat below). 409 if the user already has an OPEN visit (not explicit in the guide, a
  deliberate guard against orphaned visits from double-taps/reconnects).
PATCH /api/visits/:id/close             (visitService.closeVisit)         — closes the visit
GET  /api/visits/:id                                                      — visit detail

POST /api/shelf-photos/visit            (visitPhotoService.uploadVisitPhoto) — Pasos 1-2
  1. Validate visit is OPEN, belongs to uploadedBy, category exists, shelfunitId present
     (REQUIRED since the DBA reformulation 2026-08-07 — Shelfunit_id is NOT NULL now)
  2. Upload to AZURE_VISIT_SHELF_CONTAINER (default enterprise-shelf-visits) at
     {enterprise_id}/{pdv_id}/{session_id}/{category_id}/{filename} — session_id = Visit_id
  3. Insert RETSC_EX_SHELFPHOTO — reuses the SAME repo/table as the training flow, since
     visit_id/Retailer_id/CATEGORY_ID/ENTERPRISE_ID were already columns there; now also
     sends User_id (uploadedBy) — NOT NULL column added by the same reformulation
  4. Fires detectionPipelineService.processPhotoDetection() in the background (setImmediate,
     same fire-and-forget pattern as aiInfrastructureService) — the HTTP response doesn't
     wait for detection/identification.
  ⚠ Deliberately skips shelfPhotoQualityService/imageQualityValidator: the guide (§3) is
  explicit that the mobile already validated blur/light/framing locally — quality_status/
  blur_score/brightness arrive in the request body and are stored as-is, audit-only, never
  recomputed. Also skips hash-based dedup rejection (unlike the training flow) — the guide
  doesn't ask for it in this flow; image_hash is still computed and stored (column already
  existed), just not used to reject uploads.

detectionPipelineService.processPhotoDetection(photoId, buffer, categoryId) — Paso 3-4
  1. aiModelRepo.findPublishedByCategoryId() — queries status IN ('PUBLISHED','READY') AND
     is_active=1. NOTE the naming mismatch: the guide's literal is 'PUBLISHED', the model
     lifecycle documented above (Issue 8.4) only ever produces 'READY' for the same
     "active/published" concept — both are queried until the team reconciles which name wins.
  2. No model found → detection left pending, does NOT fail the visit (guide §5.1 callout).
  3. visionDetectionService.detectRegions() — calls "the endpoint Joel provides" (guide §5.2);
     Daniel never calls Custom Vision's Prediction API directly with credentials. STUB: if
     DETECTION_ENDPOINT_URL isn't set (nobody has delivered it yet), same pending/no-throw
     behavior as step 2 — logged, not fatal.
  4. shelfPhotoDetectionRepo.bulkInsert() — one row per detected region in
     RETSC_EX_SHELFPHOTO_DETECTION (Sku_id/EAN/ocr_text NULL at this point)
  5. Awaits productIdentificationService.identifyDetections() in-process (Paso 5) so a
     failure there is logged alongside the rest of this background job, not an orphan promise.

productIdentificationService.identifyDetections() — Paso 5
  For each detection: imageCropper.cropRegion() (sharp, normalized bbox → pixels) →
  azureVisionService.readText() (OCR stub, same permissive-stub family as
  analyzeCaption/isShelf, but returns empty text rather than inventing any — inventing OCR
  text would be worse than leaving a box unidentified) → collects all texts for the photo →
  ONE call to skuIdentificationService.buscarSkuPorTexto(texts) (batched, never one-per-box —
  guide §7.2 requires this) → shelfPhotoDetectionRepo.updateIdentification() per detection
  (the guide's exact UPDATE: EAN comes from a `RETSC_OP_SKUS` subquery keyed on the found
  Sku_id, never passed as a separate parameter; ocr_text is always saved, matched or not).

  **`skuIdentificationService.buscarSkuPorTexto()` is a PLACEHOLDER, not a real
  implementation.** The guide (§7.2) is explicit this is Joel's deliverable, not Daniel's —
  "no es algo que Daniel y Joel tengan que diseñar juntos". Today it always returns
  `matched:false` for every text, calling nothing external. See its file header for the
  documented contract and `docs/TODO-joel-visitas.md` for the rest of what's pending from Joel.

GET /api/sessions/:id/results            (visitResultsService.getResults) — Paso 6, §8.1-8.3
  `:id` is the Visit_id — the guide calls the same value "session_id" in the blob path (§3.1:
  "session_id es el Visit_id"); there is no separate "session" table/concept. Combines:
  - share_de_gondola (§8.1) — JOIN against RETSC_OP_ENTERPRISE_PRODUCT_SEG, filtered by
    enterprise_id (brand classification can differ per enterprise — guide's own note)
  - faltantes (§8.2) — RETSC_OP_ASSORTMENT (new table, no equivalent existed before) minus
    whatever was actually detected in the visit; computed per category the visit touched
    (a visit can span several — shelfPhotoRepo.listCategoryIdsByVisit()) and merged
  - sin_identificar — count of detections with Sku_id still NULL
  Response keys are the literal Spanish ones from the guide (`visit_id`, `share_de_gondola`,
  `marca`, `conteo`, `share`, `faltantes`, `sku_id`, `producto`, `sin_identificar`) rather
  than camelCase — a deliberate exception to the "Column naming convention" rule below, since
  this is an already-agreed mobile contract, not a raw MSSQL row being normalized.

GET /api/shelf-photos/unidentified        (§8.4) — passive web-dashboard view of detected-
  but-unmatched boxes ("aquí te falta inteligencia, necesitas subir fotos nuevas de este
  producto"), scoped by enterprise the same way other enterprise-scoped GETs are.
```

✅ **`RETSC_OP_RETAILER` — existencia confirmada.** La guía asume que esta tabla ya existe
con una columna `Canal` (§2.2, §3.2: "el canal se resuelve por Retailer_id →
RETSC_OP_RETAILER.Canal") — y así es: la sección "Menú por rol" más arriba documenta que el
equipo DBA la provisionó el 2026-07-26 (junto con `RETSC_OP_PLANOGRAM`, `RETSC_OP_ASSORTMENT`,
`RETSC_EX_VISIT`, `RETSC_EX_KPI`, `RETSC_EX_SHELFPHOTO_DETECTION`), con exactamente la columna
`Canal` que la guía asumía, aunque vacía (0 filas) hasta que este pipeline empezó a escribirla.
Migración `010_create_visit_photo_pipeline.sql` deliberadamente no la crea porque ya existía.
`src/repositories/retailerRepo.js` conserva su fallback defensivo (catches "Invalid object
name" y devuelve `null` en vez de lanzar), lo cual ya no hace falta para la existencia de la
tabla pero no estorba.

⚠ **ESTO YA NO ES CIERTO desde la reformulación del DBA (2026-08-07, ver sección "Database
tables" → `RETSC_EX_SHELFPHOTO`)**: `RETSC_EX_VISIT.Retailer_id` ahora tiene una FK real hacia
`RETSC_OP_RETAILER.Retailer_id` — con la tabla en 0 filas, **`POST /api/visits` no puede abrir
ninguna visita** (la BD rechaza la FK). Antes de este cambio sí era cierto que "funciona igual
vacía o con datos" porque no había FK; ya no. Bloqueante real hasta que haya datos reales en
`RETSC_OP_RETAILER` (o el equipo decida cargar al menos una fila de prueba).

`retailerRepo.js` gained `list()` (2026-08-07) — catálogo completo sin paginar, expuesto en
`GET /api/retailers` para que el mobile pueble el mapa de selección de tienda (Paso 0, previo
a `POST /api/visits`). No usa el fallback defensivo de `resolveCanalByRetailer` porque para
este momento la existencia de la tabla ya está confirmada (ver arriba); un fallo real de query
aquí sí debe propagarse. Confirmado contra `sqldb-rscope-prod` real (no solo QA): 0 filas.

⚠ **Two stubs block the flow from being fully real, both intentionally, both documented in
their own file headers**: `visionDetectionService.js` (Joel's detection endpoint — §5.2) and
`skuIdentificationService.js` (Joel's `buscarSkuPorTexto` — §7.2). Neither throws when
unconfigured; both log and leave data incomplete rather than fail the visit. Swapping either
for the real thing later should not require touching `detectionPipelineService.js` or
`productIdentificationService.js`.

### Annotation review (`/api/annotations`, Issue 7.5)

Reviews and corrects the bounding boxes (`RETSC_AI_TRAINING_ANNOTATIONS`) that Custom Vision needs to learn "where is a product" in a shelf photo. `annotationService.js`:
- **approve(id, reviewerId)** — sets `is_validated=1` + reviewer/timestamp.
- **correct(id, bbox, reviewerId)** — validates the bbox is normalized to `[0,1]` (`validateBbox()`, 400 on NaN/negative/overflow), updates coordinates, and also marks `is_validated=1`.
- **reject(id)** — hard-deletes the row; **cannot reject a photo's last remaining annotation** (409 — "use the whole-photo-rejection flow instead", which does not exist yet).
- **getPhotoReadiness(photoId)** — `{ total, validated, ready: validated >= 1 }`, checked before sending a photo to Custom Vision.

Route ordering matters: `/photo/:photoId` routes are registered before `/:id` in `annotationRoutes.js` so Express doesn't match `photo` as an `:id` param.

`annotationRepo.approvePhoto(photoId, reviewerId)` (bulk-approves every annotation on a photo and sets `photo_approved=1`) exists and is exported, but **is called from nowhere** — no service method or route wires it up yet. Treat it as a known gap if a "approve whole photo" endpoint is requested.

### Model versioning (`/api/models`, Issue 8.5) — reducido 2026-08-03 (decisión de jefatura)

`modelVersioningService.js` used to manage a full manual re-training/versioning lifecycle on top of `RETSC_AI_DETECTION_MODELS` (`canRetrain`/`startRetrain`/`completeRetrain`/`approveVersion`/`rejectVersion`/`rollback`, with a metrics gate via `isWorse()` that forced `status='AWAITING_APPROVAL'` and manual approval whenever a new version's `mean_ap` was worse than the active one). Jefatura confirmed the spec v1.4 automatic flow (fotos aprobadas → sync → umbral → training → publicación, sin gate de métricas ni aprobación humana) is the only valid one — that entire manual cycle was **eliminated**, not just disabled: no `AWAITING_APPROVAL`/`REJECTED` states, no `approved_by`/`approved_at` columns (migration 006 script adjusted, not yet applied), no `/approve`/`/reject`/`/retrain`/`/rollback`/`/complete`/`/can-retrain` endpoints. See `docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md` for the diagnosis that led to this decision.

`modelVersioningService.js` today only has two pass-through read functions feeding the "Modelos de detección" F4 menu item: `listAll()` and `listVersions(categoryId)` — no business logic of its own, just delegates to `aiModelRepo.listAll()`/`listByCategory()`.

**Pieces preserved, and now wired 2026-08-03** into the automatic flow: `aiModelRepo.setActiveVersion()` (is_active swap + `status='PUBLISHED'`, renamed from `'READY'`), `aiModelRepo.saveMetrics()` (purely monitoring — no gate wraps it), `aiModelRepo.getMaxVersion()` (increments `model_version` on publish), and `modelTrainingService.js` in full (`startTraining`/`pollTrainingStatus`/`handleTrainingCompleted` — no longer reachable via HTTP, but called directly by `annotationSyncService.checkAndUpdateThreshold()`). Two new `aiModelRepo` functions added for this wiring: `markTrained()` (advances `trained_at` independently of migration 006) and `markPublished()` (persists `model_version`/`last_publish_name` after a successful publish). See "Entrenamiento de modelos y publicación automática" below for the full mechanism.

`aiModelRepo.setActiveVersion()` runs as two sequential UPDATEs (deactivate-all, then activate-one) **without** a SQL transaction — an explicit, acknowledged gap in the code comment, same pattern already flagged for enterprise registration elsewhere in this file.

### AI/vision services — live vs. legacy

| Service | Used by | Status |
|---|---|---|
| `imageValidationService.js`, `jobService.js`, `queueService.js` | `/api/sku-images` (active flow) | Live — make SKU image upload async/job-based and hand off OCR/embeddings to an external Azure Function |
| `customVisionService.js` | `aiInfrastructureService.js` (project creation), `shelfPhotoUploadService.js` (image upload), `annotationSyncService.js` (region sync), `modelTrainingService.js` (training) | Live (Issues 8.1/8.2/8.3, cerrado 2026-07-19) — every function calls the real Custom Vision Training API v3.3 via `fetch` once `isConfigured()`; no stubs left in this service |
| `azureVisionService.js` | `/api/shelf-photos` only | Permissive stub; ignores real credentials until the SDK call is implemented |
| `aiService.js`, `hierarchyService.js` | `pipelineOrchestrator.js` only | Tied to the legacy/broken Excel image pipeline (see `loadStateRepo.js` note above) |
| `matchingService.js` | `pipelineOrchestrator.js` (legacy), plus `extractGTINFromFilename()` used standalone by `productController.js` | Mixed — the service as a whole is legacy, but that one function still has a live caller |
| `embeddingService.js`, `skuSearchService.js`, `configService.js` | Nada todavía (2026-08-04) — `buscarSkuPorTexto` es una función interna sin caller en este repo aún; Daniel/mobile la va a invocar cuando integre el flujo de fotos de visita (guía v1.9) | Live — probado contra Azure OpenAI/Azure AI Search/`RETSC_CONFIG` reales, ver sección siguiente |

### Búsqueda de SKU por texto (`buscarSkuPorTexto`, guía v1.9 sección 7.2 — construido 2026-08-04)

Dado un texto de OCR (de una cajita detectada en una foto de visita), encuentra el SKU más parecido en el índice vectorial `retsc-sku-vectors` (Azure AI Search, embeddings ada-002, similitud coseno) — el paso de "identificar producto" del flujo de inferencia de la guía v1.9, distinto del flujo de entrenamiento ya cableado (ver secciones de arriba). Es una **función interna**, sin endpoint HTTP propio — pensada para que el propio backend la invoque al procesar una foto de visita, no para que Daniel la llame por REST (si eso cambia, agregar una ruta delgada que delegue acá, sin duplicar lógica).

```
skuSearchService.buscarSkuPorTexto(textos: string[])
  → { texto_original, sku_id, similarity_score, matched }[]
```

Piezas nuevas:
- **`embeddingService.js`** — `embedText(text)`, réplica (reescrita, no copiada) del mismo llamado que usa `Functions/src/lib/openaiEmbedding.js` (repo hermano `../Functions`, que sí puebla el índice — no se toca desde acá) contra Azure OpenAI ada-002 (`AZURE_OPENAI_ENDPOINT`/`KEY`/`EMBEDDING_DEPLOYMENT`, agregadas a `.env`/`.env.example` 2026-08-04). **Debe mantenerse sincronizado** con esa Function — mismo endpoint/deployment/api-version — o los vectores generados acá dejan de ser comparables (coseno) contra los ya indexados.
- **`configService.js`** + **`configRepo.js`** — primer lector genérico de `RETSC_CONFIG` en el repo (no existía ningún helper de este tipo antes). Cache en memoria de 60s, normalización coma→punto, validación de rango, fallback si la fila falta/no parsea. `getNumberConfig('SKU_MATCH_THRESHOLD', 0.85, {min:0,max:1})` es el primer consumidor — pensado para reusarse en cualquier config futura que viva en esa tabla.
- **`skuSearchService.js`** — orquesta: resuelve el umbral (una vez por llamada, no por texto) → por cada texto, en paralelo con concurrencia acotada (`CONCURRENCY=8`, sin dependencias nuevas) → `embedText()` → búsqueda vectorial vía REST directo contra Azure AI Search (`POST /indexes/{index}/docs/search?api-version=2023-11-01`, `vectorQueries` sobre el campo `embedding`, sin SDK — mismo patrón sin-SDK que `customVisionService.js`; el backend no tenía `@azure/search-documents` como dependencia) → compara el top-1 contra el umbral.

⚠ **Asimetría conocida entre indexado y búsqueda** (investigada antes de construir, ver header del archivo): el índice se pobló embebiendo TEXTO ENRIQUECIDO (`"EAN: ... | Producto: ... | Categoría: ... | <OCR>"`, ver `buildEnrichedText()` en `Functions/src/functions/ProcessSkuImageQueue.js`) — acá solo hay OCR crudo de la cajita (no hay EAN/Producto/Categoría todavía, es lo que se busca). Se embebe el OCR tal cual, sin placeholders inventados. Riesgo aceptado: los scores de coseno pueden salir sistemáticamente más bajos que comparando enriquecido-contra-enriquecido — el umbral configurable (`RETSC_CONFIG`) es la palanca para absorber esto con datos reales, no una corrección de código.

**Manejo de error por-texto**: cada texto se resuelve en su propia función (`resolveOne`) que nunca lanza — un fallo (Azure OpenAI o Azure Search caídos para ese ítem puntual) degrada a `matched:false` logueado, sin romper el resto del arreglo ni cambiar su longitud.

Probado contra datos reales (2026-08-04): match real (`"NIVEA MEN INVISIBLE FOR BLACK & WHITE 48h"` → `sku_id=1`, score 0.916), no-match, arreglo mixto, y umbral configurable (mismo score, `matched:true` con 0.85 / `matched:false` con 0.95, confirmando que el umbral no está hardcodeado).

### Validación de OCR+embeddings (`scripts/run-ocr-embedding-validation.js`, Pasos 1-5 del proceso de María — construido 2026-08-04)

Mide qué tan bien `buscarSkuPorTexto` identifica productos, reusando fotos de **entrenamiento** ya anotadas (`RETSC_AI_TRAINING_PHOTOS`/`RETSC_AI_TRAINING_ANNOTATIONS`) como si fueran fotos de góndola reales — sin depender de un modelo Custom Vision publicado ni del pipeline de inferencia completo (que todavía no existe, ver `docs/DIAGNOSTICO-...` de sesiones anteriores para el estado de la predicción). Corre los Pasos 1-5 del proceso documentado por María; los Pasos 6 (un humano llena `sku_id_real` a mano) y 7 (`SELECT` que calcula el % de acierto) quedan **deliberadamente fuera** — el script no los hace.

Flujo: trae fotos `APROBADA` + sus anotaciones (`--limit=N`, default 100) → descarga la foto original UNA vez por `photo_id` (`blobStorageService.downloadFromContainer()`, nuevo — antes el archivo solo tenía funciones de upload) → recorta cada cajita con `sharp` según `bbox_left/top/width/height` (floats normalizados `[0,1]`, se multiplican por el ancho/alto real) → OCR del recorte vía `visionOcrService.js` (nuevo) → junta todos los OCR exitosos de la corrida en un solo llamado a `skuSearchService.buscarSkuPorTexto()` (reusada, no reimplementada) → inserta cada resultado en `RETSC_TEST_OCR_EMBEDDING_VALIDATION` con `sku_id_real` en `NULL`.

`visionOcrService.js` replica el mismo llamado que `Functions/src/lib/visionOcr.js` (Image Analysis 4.0, `features=read`, mismo `api-version=2024-02-01`) — única diferencia deliberada: manda el recorte como bytes (`application/octet-stream`) en vez de una URL firmada con SAS, porque ya está en memoria tras el crop (mismo patrón que `customVisionService.js` para subir a Custom Vision). Mismo motor/versión de OCR que usó la Function para indexar → texto comparable.

**Idempotencia**: `RETSC_TEST_OCR_EMBEDDING_VALIDATION` no tiene constraint único en `annotation_id` (solo PK en `validation_id`) — el script borra la fila existente de esa anotación antes de insertar, así que re-correrlo no duplica filas, pero **si esa anotación ya tenía `sku_id_real` cargado por un humano (Paso 6), se pierde** — no re-correr sobre anotaciones que ya pasaron el Paso 6 sin confirmar antes.

**Error por-anotación**: un fallo de descarga/recorte/OCR para una anotación puntual (probado con una bbox fuera de rango real: `extract_area: bad extract area`) se captura y se inserta igual como fila con `notas='ERROR: ...'`, `matched=false` — no rompe el resto de la corrida.

⚠ **Estado real al construirse (2026-08-04): 0 fotos en `APROBADA` y 0 anotaciones en toda la tabla** — el equipo de anotación (Issue #42, externo) todavía no generó ninguna cajita. El script se probó con datos sintéticos temporales (una foto real marcada `APROBADA` + 2 anotaciones de prueba insertadas y luego borradas, revirtiendo todo al estado original) para confirmar que la mecánica completa funciona — no hay todavía una corrida real contra anotaciones del equipo de anotación.

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

`src/services/customVisionService.js` ya **no** es un stub. `createProject()`, `createImageFromData()` (implementado 2026-07-19 — cerraba el único hueco que bloqueaba el sync E2E), `createImageRegions()`, `deleteImageRegion()`, `deleteImages()`, `trainProject()`, `getIteration()`, `getIterationPerformance()` hacen llamadas HTTP reales (vía `fetch` nativo, no el SDK oficial — la key de Azure AI Services unificada tiene caracteres no-ASCII que el módulo `http` de Node rechaza en headers). Probado end-to-end contra CV real: upload real → `createImageRegions` → `cv_region_id` poblado → segunda pasada no duplica (guarda `splitByCvRegionId`).

**Issue #35 (tags por proyecto) y 8.4 (publicación) — COMPLETADOS 2026-08-03, bloqueantes de Azure RESUELTOS 2026-08-04**: `listTags()`, `createTag()`, `ensureTag()` (crea/reusa por nombre, reemplaza las env vars `CV_TAG_*`) y `publishIteration()` (con guardia si `predictionResourceId` es null/inválido) ya existen, probados contra CV real y cableados al flujo automático (ver "Entrenamiento de modelos y publicación automática" arriba). Ya no queda config de Azure pendiente para este flujo:
- `prediction_resource_id` ya no se trunca a `NULL` — la columna se amplió a `VARCHAR(200)` (2026-08-04), el guard de `aiInfrastructureService.js` y los bindings de `aiModelRepo.js` se ajustaron al nuevo tamaño, y las 2 categorías existentes (`category_id=5,6`) se re-poblaron con el Resource ID completo.
- El `BadRequestInvalidPublishTarget` (probado 2026-08-03) era el mismo problema — el `.env` tenía el Resource ID truncado, sin `/accounts/{nombre}`. Corregido; `publishIteration` publica sin error contra CV real (probado 2026-08-04).
- La migración `006_add_metrics_to_detection_models.sql` **ya se aplicó** contra `sqldb-rscope-prod` (2026-08-04, ajustada para no incluir `approved_by`/`approved_at` — ver sección de limpieza más arriba); `aiModelRepo.saveMetrics()` ya puede persistir métricas reales.
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

### 17. Migración 009 (`last_training_error`) escrita, pendiente de aplicar contra `sqldb-rscope-prod`

`migrations/009_add_last_training_error_to_detection_models.sql` agrega `RETSC_AI_DETECTION_MODELS.last_training_error VARCHAR(500) NULL`, ya consumida por `aiModelRepo.markTrainingFailed()`/`setTrainingError()` (cableados en `modelTrainingService.js` 2026-08-08 — ver "Hallazgo real 2026-08-08" arriba). Mientras no se aplique, esas funciones lanzan "Invalid column name" y el caller lo atrapa con un `console.error` extra (mismo patrón defensivo que la migración 006 antes de aplicarse) — el comportamiento hoy sigue siendo el silencioso de antes, no se rompe nada por dejarla pendiente. Aplicar por SSMS cuando el equipo lo decida, mismo criterio que las migraciones 005-008.

