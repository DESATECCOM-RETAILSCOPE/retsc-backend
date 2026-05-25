# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev     # Start development server with nodemon (auto-reload)
npm start       # Start production server
node scripts/seed.js  # Seed JSON data files with a demo user and enterprise
```

No lint or test commands are configured.

## Environment Setup

Copy `.env.example` to `.env` and fill in values. Required variables:

- `PORT` — server port
- `DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — MSSQL credentials (DB runs on port 1435, not the default 1433; only used by legacy auth service)
- `JWT_SECRET`, `JWT_EXPIRES_IN` — token signing and expiry (default 24h)
- `BLOB_STORAGE_MODE` — `mock` (default) or `azure`; mock writes files to `data/blob-mock/` and serves them at `/blob-mock/`
- `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_BLOB_CONTAINER` — required only when `BLOB_STORAGE_MODE=azure`
- `BLOB_MOCK_BASE_PATH` — override mock storage root (default: `data/blob-mock`)
- `BLOB_HIERARCHY_THRESHOLD` — folder-split threshold for blob paths (default: 500)

## Architecture

Express layered architecture with two distinct persistence layers:

```
server.js                     Entry point
src/app.js                    CORS, body parsing, route mounting, 404/error handlers
src/routes/                   Route definitions
src/controllers/              Input validation, calls services, formats HTTP responses
src/services/                 Business logic
src/repositories/             Data access — all DB reads/writes go here
src/middlewares/authMiddleware.js  JWT verification; attaches decoded payload to req.user
src/config/db.js              MSSQL connection pool (legacy, only used by authService)
data/*.json                   JSON flat-file storage (current primary persistence)
data/blob-mock/               Local mock blob storage, served as static files
uploads-temp/                 Temporary files during pipeline runs; auto-cleaned after job
```

### Dual persistence layers

The codebase is mid-migration from MSSQL to JSON flat files:

- **JSON layer** (`src/repositories/jsonRepo.js`): All current feature code uses this. Provides `readAll`, `readById`, `findOne`, `findMany`, `insert`, `update`, `remove`, `transaction`. Per-file write locks prevent race conditions. Each "table" is a `data/<name>.json` file.
- **MSSQL layer** (`src/config/db.js`): Used only by `authService.js` — login/register against `RETSC_OP_USERS`. All other repos delegate to `jsonRepo`.

All repository files in `src/repositories/` are thin wrappers over `jsonRepo` that define the table name, primary key field, and any domain-specific filter queries.

### API routes

| Route | Auth | Notes |
|---|---|---|
| `POST /api/auth/register` | No | bcrypt hash, MSSQL insert |
| `POST /api/auth/login` | No | MSSQL lookup, returns JWT `{userId, email, username}` |
| `GET /api/auth/me`, `GET /api/auth/users` | Bearer JWT | MSSQL |
| `POST /api/enterprises` | No | JSON file |
| `GET/PUT /api/users/*` | Bearer JWT | JSON file |
| `GET /api/categories` | Bearer JWT | JSON file |
| `GET /api/enterprises/me/categories` | Bearer JWT | JSON file |
| `GET /api/products` | Bearer JWT | JSON file; `?enterpriseId`, `?categoryId`, `?search`, `?page`, `?limit` |
| `POST /api/products/upload-excel` | Bearer JWT | Parses `.xlsx`; returns parsed rows + validation errors |
| `POST /api/products/upload-images` | Bearer JWT | Up to 200 images; stored under `uploads-temp/<tmpId>/` |
| `POST /api/products/process/:jobId` | Bearer JWT | Kicks off async pipeline |
| `GET /api/products/processing-status/:jobId` | Bearer JWT | Polls pipeline state |
| `GET /health` | No | `{status, timestamp}` |

### Product ingestion pipeline

`src/services/pipelineOrchestrator.js` runs an async 7-step job tracked in `data/loadstates.json`:

1. **validating_gtins** — filters rows against EAN8/UPC12/EAN13 check digits
2. **hashing** — SHA-based dedup against `data/images.json` and within the batch
3. **matching** — GTIN extracted from image filename prefix (e.g., `0123456789012_front.jpg` → GTIN `0123456789012`) matched to Excel rows
4. **hierarchy** — decides blob storage subfolder depth based on product counts vs. `BLOB_HIERARCHY_THRESHOLD`
5. **uploading** — `blobStorageService` uploads to Azure or mock; fails job if >50% fail
6. **persisting** — upserts products and inserts image records into JSON files
7. **ai_tracking** — records `pending_training` entries in `data/aimodels.json` per category

The pipeline is fire-and-forget: `POST /process/:jobId` returns immediately; clients poll `/processing-status/:jobId`.

### Excel parsing

`src/services/excelService.js` reads only the first sheet. Required columns: `gtin`, `description`, `category`. Optional: `subcategory`, `segment`, `brand`. Column headers are matched case-insensitively with accent normalization, so Spanish variants (`descripción`, `categoría`, etc.) are accepted.

### Adding new features

Follow the existing pattern: route → controller → service → repository (extending `jsonRepo`). Keep all DB/file access out of controllers and services — repositories only.
