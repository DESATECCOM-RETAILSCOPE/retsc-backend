# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev     # Start development server with nodemon (auto-reload)
npm start       # Start production server
node scripts/create-test-data.js  # Generate test Excel and images under test-data/
node scripts/migrate-add-brand.js # Add Brand column to RETSC_OP_PRODUCTS (idempotent)
node src/utils/gtinValidator.js   # Run inline GTIN self-tests
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
src/utils/gtinValidator.js    EAN8/UPC12/EAN13 check-digit validation
src/utils/imageHasher.js      SHA-256 hashing for dedup
src/utils/validators.js       Shared input validators (isValidEmail)
src/utils/mailer.js           Email delivery via nodemailer; mock mode when SMTP_HOST is unset
data/blob-mock/               Local mock blob storage, served as static files
uploads-temp/                 Temporary files during pipeline runs; auto-cleaned after job
```

`src/repositories/jsonRepo.js` is dead code — it exists but no repository imports it. All real persistence uses MSSQL.

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

Refresh flow: `POST /api/auth/refresh` takes `{ refreshToken }` in the body and returns a new `accessToken`. Logout is stateless — no server-side token revocation.

Forgot password flow: `POST /api/auth/forgot-password` accepts `{ identifier }` (email or username), generates a new 10-character password, updates it in the DB, and emails it to the user. Always returns the same generic message regardless of whether the user exists (prevents user enumeration).

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
| `POST /api/skus/upload-excel` | Bearer | Upload SKU Excel (multipart `file` + `enterpriseCategoryId`); synchronous; returns `{ metrics, errors }` |
| `GET /health` | No | `{status, timestamp}` |

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

Follow the existing pattern: route → controller → service → repository. All SQL access belongs in repositories only — controllers and services must not call `db.js` directly. When a repository returns MSSQL rows, always map them to camelCase in the service via a `toDTO()` function. Errors need a `statusCode` property for `handleError()` to forward the correct HTTP status — use the `svcError(msg, statusCode)` pattern found in every service.

When an operation must be atomic across multiple inserts/deletes (e.g. replacing a category set), use an explicit SQL transaction inside the repository — see `enterpriseCategoryRepo.js` for the pattern.

HTTP responses always follow `{ success: true, ...data }` on success and `{ success: false, message: "..." }` on error.
