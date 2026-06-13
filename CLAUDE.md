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
node src/utils/gtinValidator.js    # Run inline GTIN self-tests
node test-db.js                    # Validate Azure SQL connectivity
```

No lint or test commands are configured.

## Environment Setup

Copy `.env.example` to `.env` and fill in values. Required variables:

- `PORT` — server port
- `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER`, `SQL_PASSWORD`, `SQL_PORT` — Azure SQL credentials
- `JWT_SECRET`, `JWT_EXPIRES_IN` — access token signing and expiry (default 1h)
- `JWT_REFRESH_SECRET`, `JWT_REFRESH_EXPIRES_IN` — refresh token signing and expiry (default 30d)
- `BLOB_STORAGE_MODE` — `mock` (default) or `azure`; mock writes to `data/blob-mock/` and serves at `/blob-mock/`
- `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_BLOB_CONTAINER` — required only when `BLOB_STORAGE_MODE=azure`
- `BLOB_MOCK_BASE_PATH` — override mock storage root (default: `data/blob-mock`)
- `BLOB_HIERARCHY_THRESHOLD` — folder-split threshold for blob paths (default: 500)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — email delivery; leave `SMTP_HOST` empty for mock mode (logs to console)
- `AZURE_GLOBAL_TRAINING_CONTAINER` — blob container for AI training images (default: `global-sku-training`); shared by both the category AI infra flow and the SKU image ingestion flow
- `CUSTOM_VISION_TRAINING_KEY`, `CUSTOM_VISION_PREDICTION_KEY`, `CUSTOM_VISION_ENDPOINT`, `CUSTOM_VISION_PREDICTION_RESOURCE_ID` — Azure Custom Vision credentials; leave unset until credentials arrive (`customVisionService.js` is a stub that returns null when these are missing)

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
src/middlewares/requireAdmin.js    Role check; requires req.user.roleName === 'Admin'
src/config/db.js              MSSQL connection pool (max 10, lazy init on first getPool() call)
src/utils/gtinValidator.js              EAN8/UPC12/EAN13 check-digit validation
src/utils/imageHasher.js               SHA-256 hashing for dedup
src/utils/validators.js                Shared input validators (isValidEmail)
src/utils/mailer.js                    Email delivery via nodemailer; mock mode when SMTP_HOST is unset
src/utils/categoryNameNormalizer.js    Slug generator used by both AI infra and SKU image blob paths
src/utils/skuImageFilenameParser.js    Parses `{EAN}_{view}.{ext}` filenames; returns null on invalid names
src/utils/skuImageFilenameGenerator.js Generates canonical blob filenames from { ean, view, ext }
data/blob-mock/                        Local mock blob storage, served as static files
uploads-temp/                          Temporary files during pipeline runs; auto-cleaned after job
```

`src/repositories/jsonRepo.js` is dead code — it exists but no repository imports it. All real persistence uses MSSQL.

### Smart category AI infrastructure (Issue 3.1.1)

When a category is created or updated with `is_smart_dtc=1`, the system automatically provisions AI infrastructure in background (fire-and-forget, does not block the HTTP response):

```
categoryService.createCategory()
  └─► aiInfrastructureService.provisionForCategory()   [background]
        ├─► blobStorageService.createMarker()           → global-sku-training/dtc-{slug}/.keep
        ├─► globalBlobContainerRepo.insert()            → RETSC_INF_GLOBAL_BLOB_CONTAINERS
        ├─► aiModelRepo.insert()                        → RETSC_AI_DETECTION_MODELS (status=PENDING)
        └─► customVisionService.createProject()         → null (stub, credenciales pendientes)
```

Key files:
- `src/utils/categoryNameNormalizer.js` — slug generator for blob prefix names (e.g. `"Vino Tinto"` → `"vino-tinto"`)
- `src/services/aiInfrastructureService.js` — orchestrator; never throws, returns `{ status, errors[] }`
- `src/services/customVisionService.js` — stub; all functions return null until credentials arrive
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
| `productRepo.js` | `RETSC_OP_PRODUCTS` |
| `imageRepo.js` | `RETSC_LOG_IMAGE_UPLOAD` |
| `loadStateRepo.js` | `RETSC_LOG_SKU_UPLOAD` (⚠ broken — see below) |
| `skuRepo.js` | `RETSC_OP_PRODUCTS`, `RETSC_OP_SKUS`, `RETSC_OP_ENTERPRISE_SKUS`, `RETSC_LOG_SKU_UPLOAD` |
| `aiModelRepo.js` | `RETSC_AI_DETECTION_MODELS` |
| `skuFeatureRepo.js` | `RETSC_AI_SKU_FEATURES` + `RETSC_AI_SKU_IMAGE_METADATA` |
| `skuImageLogRepo.js` | `RETSC_LOG_IMAGE_UPLOAD` (shared with `imageRepo.js`, different columns) |
| `jobRepo.js` | `RETSC_LOG_JOBS` |

`RETSC_OP_SKUS` is accessed directly by `skuImageService.js` (via inline SQL, no dedicated repo) for EAN lookups and updating `image_url`/`has_visual_variant` on first image upload.

`RETSC_OP_SKUS` columns: `SKU_ID`, `EAN`, `product_id` (FK → `RETSC_OP_PRODUCTS`), `creation_date`, `image_url`.

`RETSC_OP_ENTERPRISE_SKUS` columns: `enterprise_id`, `sku_id` (FK → `RETSC_OP_SKUS`), `selected_category_id` (FK → `RETSC_OP_ENTERPRISE_CATEGORIES.enterprise_category_id`), `detection_category_id` (FK → `RETSC_OP_CATEGORIES.Category_id`, used for AI), `created_at`.

`RETSC_OP_ENTERPRISE_CATEGORIES` columns: `enterprise_category_id` (PK), `enterprise_id`, `selected_category_id` (FK → `RETSC_OP_CATEGORIES`), `resolved_category_id` (nullable — DTC-resolved override; falls back to `selected_category_id` when null), `status` (`'ACTIVE'` or other).

⚠ **`productRepo.js` partial dead code**: `findByGtinAndEnterprise`, `insert`, `insertMany`, and `update` use non-existent columns (`GTIN`, `Enterprise_id`, `Description`, etc.) — they are leftovers from the old pipeline and will fail at runtime. Only `findById` and `listByEnterprise` are functional.

**CRITICAL — real column names (verified from Azure SQL, June 2026):**

`RETSC_OP_PRODUCTS` columns: `product_id`, `Product_dsc`, `Category_id`, `Checklist`, `creationdate`, `product_key`, `status`, `Brand` (added via `scripts/migrate-add-brand.js`). There is NO `Subcategory`, `Segment`, `Enterprise_id`, `GTIN`, or `Description`. Enterprise-specific metadata lives in `RETSC_OP_ENTERPRISE_PRODUCT_SEG`.

`RETSC_LOG_IMAGE_UPLOAD` real columns: `image_log_id`, `enterprise_id`, `upload_batch_id` (NOT NULL), `sku_id`, `ean`, `image_name`, `image_url`, `image_hash`, `image_status`, `process_status` (NOT NULL), `ocr_status`, `embeddings_status`, `error_code`, `error_message`, `created_at`. No `Product_id`, `Hash`, `Blob_url`, or `Status`.

`RETSC_LOG_SKU_UPLOAD` real columns: `log_id`, `enterprise_id`, `upload_batch_id` (NOT NULL), `row_number`, `ean`, `sku_description`, `selected_category_id`, `detection_category_id`, `process_status` (NOT NULL), `error_code`, `error_message`, `created_at`. **`loadStateRepo.js` uses `Job_id`, `Excel_data`, `Image_files`, `Metrics` — none of these columns exist. The old image-pipeline flow (`pipelineOrchestrator`) is non-functional and requires a DB schema redesign.**

When in doubt about column names, query: `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '<table>'`.

### Auth flow

Login issues two tokens: a short-lived `accessToken` and a long-lived `refreshToken`. The login response also includes `token` as an alias for `accessToken` for legacy frontend compatibility — do not remove it until the frontend migrates.

Login response includes `user.enterpriseDsc` so the frontend can display the enterprise name without an extra fetch.

JWT payload: `{ userId, email, username, enterpriseId, roleId, roleName }`. Use `req.user.roleName` for permission checks. `requireAdmin` middleware enforces `roleName === 'Admin'` and must be applied after `authMiddleware`.

Refresh token payload is minimal `{ userId, type: 'refresh' }` — the `type` field is checked during refresh verification to prevent access tokens from being used as refresh tokens. Refresh endpoint validates both signature and `type === 'refresh'`; throws 401 if either fails.

Login security: the password check runs before the user-existence check (timing-attack defense). Both "user not found" and "wrong password" return the same generic 401. If a user has multiple active enterprise relations, the one with the lowest `Id` is selected (legacy behavior). Users with `Status != 1` or no active enterprise relations are rejected at login.

All email inputs are normalized via `email.trim().toLowerCase()` before processing in login, register, and forgot-password.

Refresh flow: `POST /api/auth/refresh` takes `{ refreshToken }` in the body and returns a new `accessToken`. Logout is stateless — no server-side token revocation.

Forgot password flow: `POST /api/auth/forgot-password` accepts `{ identifier }` (email or username), generates a new 10-character password (from an alphabet that excludes ambiguous chars like `0/O`, `1/I/l`), updates it in the DB, and emails it to the user. Always returns the same generic message regardless of whether the user exists (prevents user enumeration). There is no change-password endpoint — only this forgot-password flow exists.

### Middleware mounting pattern

`src/app.js` applies `authMiddleware` globally for some route groups (e.g. `/api/users`, `/api/categories`, `/api/roles`), but other groups (`/api/enterprises`, `/api/products`) do **not** receive it at mount time — those route files apply `authMiddleware` inline per protected route. When adding a new route file, check whether to apply auth at the app level or per route. `requireAdmin` is always applied inline after `authMiddleware`, never globally.

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
| `POST /api/enterprises` | No | Register enterprise + admin user |
| `GET /api/enterprises` | Bearer + Admin | List all enterprises (alias of /list) |
| `GET /api/enterprises/list` | Bearer + Admin | List all enterprises |
| `GET /api/enterprises/:id` | Bearer + Admin | Enterprise detail |
| `POST /api/enterprises/create` | Bearer + Admin | Create enterprise (no admin user) |
| `PUT /api/enterprises/:id` | Bearer + Admin | Update enterprise (accepts status field) |
| `GET /api/users` | Bearer | Users of the authenticated enterprise |
| `GET /api/users/by-cedula/:ced` | Bearer | Find user by ID number |
| `POST /api/users` | Bearer | Create user and assign to enterprise |
| `POST /api/users/assign` | Bearer | Assign existing user to enterprise |
| `PUT /api/users/:id` | Bearer | Update user |
| `PUT /api/users/:userId/enterprises/:enterpriseId` | Bearer | Update user-enterprise relation |
| `GET /api/roles` | Bearer | List all roles |
| `GET /api/roles/:id` | Bearer | Role detail |
| `POST /api/roles` | Bearer | Create role |
| `PUT /api/roles/:id` | Bearer | Update role |
| `PATCH /api/roles/:id/status` | Bearer | Activate/deactivate role |
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
| `GET /api/products` | Bearer | Products with pagination/search |
| `POST /api/products/upload-excel` | Bearer | Parse `.xlsx`; returns rows + errors |
| `POST /api/products/upload-images` | Bearer | Up to 200 images → `uploads-temp/<jobId>/` |
| `POST /api/products/process/:jobId` | Bearer | Start async pipeline |
| `GET /api/products/processing-status/:jobId` | Bearer | Poll pipeline state |
| `GET /health` | No | `{status, timestamp}` |
| `POST /api/categories/:id/retry-ai-infra` | Bearer + Admin | Reintenta provisioning IA de categoría smart |

### Enterprise registration

`POST /api/enterprises` creates an enterprise plus an admin user in one operation. The `type` field must be one of: `"Proveedor"`, `"Detallista"`, `"Empresa de servicios"`. If the admin user already exists by `cédula` with no active relations, the user is reactivated with a fresh generated password instead of creating a new record.

This operation is **not** wrapped in a SQL transaction — it uses manual compensating rollbacks (delete enterprise then delete user) if a later step fails. This is unlike `enterpriseCategoryRepo.js`, which uses an explicit `pool.transaction()`. Be aware of this gap when modifying the registration flow.

### Enterprise status

`RETSC_OP_ENTERPRISE` has a `status` column (lowercase, BIT). Note: unlike other tables in the project that use `Status` (Pascal case), this column is lowercase — always reference it as `row.status` in the repository layer, not `row.Status`.

### Product ingestion pipeline

`src/services/pipelineOrchestrator.js` runs an async 7-step job tracked in `RETSC_LOG_SKU_UPLOAD`:

1. **validating_gtins** — filters rows against EAN8/UPC12/EAN13 check digits
2. **hashing** — SHA-256 dedup against `RETSC_LOG_IMAGE_UPLOAD` and within the batch
3. **matching** — GTIN from image filename prefix (e.g. `0123456789012_front.jpg`) matched to Excel rows; one image per GTIN
4. **hierarchy** — calculates blob subfolder depth based on product counts vs. `BLOB_HIERARCHY_THRESHOLD`
5. **uploading** — uploads to Azure or mock in batches of 10 with exponential-backoff retry (1s/2s/4s, 3 attempts); fails job if >50% fail
6. **persisting** — upserts products into `RETSC_OP_PRODUCTS`; inserts image records into `RETSC_LOG_IMAGE_UPLOAD`
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

### SKU ingestion flow (current)

`POST /api/skus/upload-excel` is the **active** SKU upload path (replaces the old image-pipeline for product cataloguing). It is **synchronous** — the response includes final `{ metrics, errors }` in one call.

Flow in `src/services/skuService.js`:
1. Validate `enterpriseCategoryId` belongs to the authenticated enterprise (`RETSC_OP_ENTERPRISE_CATEGORIES`).
2. Parse the Excel file — required columns: `gtin` (aliases: `ean`, `barcode`, `codigo`, etc.) and `description`; optional: `brand`. Headers are accent/case-normalized.
3. For each row: validate EAN format (8, 12, or 13 numeric digits); upsert `RETSC_OP_PRODUCTS` (via `product_key = EAN`); upsert `RETSC_OP_SKUS`; insert into `RETSC_OP_ENTERPRISE_SKUS` if not already present; log to `RETSC_LOG_SKU_UPLOAD`.
4. `detection_category_id` on `RETSC_OP_ENTERPRISE_SKUS` is set from `resolved_category_id ?? selected_category_id` of the enterprise category row.

`skuService.js` uses GTIN length heuristics to fix leading-zero loss: a 7-digit string is padded to 8, an 11-digit string to 12.

### Excel parsing (legacy product pipeline)

`src/services/excelService.js` reads only the first sheet. Required columns: `gtin`, `description`, `category`. Optional: `subcategory`, `segment`, `brand`. Headers matched case-insensitively with accent normalization (e.g. `descripción`, `categoría`). GTINs with a leading zero preserved if total length is 12 or 13 digits. The xlsx library sometimes casts numeric GTINs to floats; excelService corrects this.

### Input validation

All email fields are validated with `isValidEmail()` from `src/utils/validators.js` before any DB operation. This applies to: auth register, user create/update, enterprise register/create/update. Returns HTTP 400 with message `'Formato de email inválido'` on failure.

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

### 6. Custom Vision — integración pendiente de credenciales

`src/services/customVisionService.js` — El servicio es un **stub completo**. `isConfigured()` devuelve `false` hasta que se agreguen `CUSTOM_VISION_TRAINING_KEY` y `CUSTOM_VISION_ENDPOINT` al `.env`. Cuando lleguen las credenciales:
- Instalar SDKs: `npm install @azure/cognitiveservices-customvision-training @azure/cognitiveservices-customvision-prediction @azure/ms-rest-js`
- Completar `createProject()` y agregar `triggerTraining()`, `getPublishedIterations()`
- Correr el backfill: `node scripts/backfill-smart-categories.js` (crear este script)
- Los modelos en `RETSC_AI_DETECTION_MODELS` con `status='PENDING'` se actualizarán mediante `POST /api/categories/:id/retry-ai-infra`

### 7. ~~Columna `prefix` pendiente en `RETSC_INF_GLOBAL_BLOB_CONTAINERS`~~ — COMPLETADO

Migración `migrations/003_add_prefix_to_global_blob_containers.sql` agrega la columna `prefix VARCHAR(100)` y migra los valores existentes. `globalBlobContainerRepo.js` ya usa la columna directamente — los helpers temporales `buildDescription()` y `extractPrefixFromDescription()` fueron eliminados.

### 8. ~~Backfill de categorías smart existentes — script pendiente de crear~~ — COMPLETADO

Script creado en `scripts/backfill-smart-categories.js`. Correr con `npm run backfill:smart-categories -- --dry-run` primero, luego sin `--dry-run`. Pre-requisito: migración 003 debe estar aplicada. El script es idempotente.

### 9. Enterprise registration not wrapped in a SQL transaction

`src/services/enterpriseService.js` — The `POST /api/enterprises` flow (enterprise + admin user creation) uses manual compensating rollbacks instead of a real DB transaction. If a step fails mid-way, the service manually deletes the already-inserted enterprise or user. This is a known gap. If this flow is expanded, consider wrapping it in `pool.transaction()` following the `enterpriseCategoryRepo.js` pattern.
