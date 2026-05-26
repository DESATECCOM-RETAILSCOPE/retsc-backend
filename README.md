# retsc-backend

API REST para RetailScope — Node.js + Express + Azure SQL.

## Cómo arrancar

```bash
npm install
cp .env.example .env   # completar variables (ver sección de entorno)
npm run dev            # servidor con auto-reload
```

## Variables de entorno

| Variable | Descripción |
|---|---|
| `PORT` | Puerto del servidor (default 3000) |
| `SQL_SERVER` | Azure SQL Server hostname |
| `SQL_PORT` | Puerto SQL (default 1433) |
| `SQL_USER` | Usuario SQL |
| `SQL_PASSWORD` | Contraseña SQL |
| `SQL_DATABASE` | Nombre de la base de datos |
| `JWT_SECRET` | Clave de firma de tokens |
| `JWT_EXPIRES_IN` | Expiración del token (default `24h`) |
| `BLOB_STORAGE_MODE` | `mock` (local) o `azure` |
| `BLOB_MOCK_BASE_PATH` | Carpeta para mock local (default `data/blob-mock`) |
| `AZURE_STORAGE_CONNECTION_STRING` | Connection string Azure (solo si `BLOB_STORAGE_MODE=azure`) |
| `AZURE_BLOB_CONTAINER` | Nombre del contenedor Azure (default `retailscope-images`) |
| `BLOB_HIERARCHY_THRESHOLD` | Productos por categoría para aumentar profundidad de ruta (default 500) |

## Endpoints

### Auth

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/auth/register` | No | Crear usuario |
| POST | `/api/auth/login` | No | Iniciar sesión, devuelve JWT |
| GET | `/api/auth/me` | Bearer | Usuario actual |
| GET | `/api/auth/users` | Bearer | Todos los usuarios |

### Empresas

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/enterprises` | No | Registrar empresa + usuario admin |
| GET | `/api/enterprises/list` | Bearer + Admin | Listar todas las empresas |
| GET | `/api/enterprises/:id` | Bearer + Admin | Detalle de empresa |
| POST | `/api/enterprises/create` | Bearer + Admin | Crear empresa (sin usuario admin) |
| PUT | `/api/enterprises/:id` | Bearer + Admin | Editar empresa |

### Usuarios

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/users` | Bearer | Usuarios de la empresa autenticada |
| GET | `/api/users/by-cedula/:ced` | Bearer | Buscar por cédula |
| POST | `/api/users` | Bearer | Crear usuario y asignar a la empresa |
| POST | `/api/users/assign` | Bearer | Asignar usuario existente |
| PUT | `/api/users/:id` | Bearer | Actualizar datos del usuario |
| PUT | `/api/users/:userId/enterprises/:enterpriseId` | Bearer | Actualizar relación usuario-empresa |

### Roles

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/roles` | Bearer | Listar todos los roles |
| GET | `/api/roles/:id` | Bearer | Detalle de rol |
| POST | `/api/roles` | Bearer | Crear rol |
| PUT | `/api/roles/:id` | Bearer | Editar rol |
| PATCH | `/api/roles/:id/status` | Bearer | Activar/desactivar rol |

### Categorías

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/categories` | Bearer | Árbol de categorías global |
| GET | `/api/enterprises/me/categories` | Bearer | Categorías de la empresa |

### Productos (pipeline de carga)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/products/upload-excel` | Bearer | Subir Excel con productos |
| POST | `/api/products/upload-images` | Bearer | Subir imágenes para un job |
| POST | `/api/products/process/:jobId` | Bearer | Ejecutar pipeline |
| GET | `/api/products/processing-status/:jobId` | Bearer | Estado del job |
| GET | `/api/products` | Bearer | Listar productos de la empresa |

### Salud

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/health` | No | `{ status: "OK", timestamp }` |

---

## Pipeline de productos

```
1. POST /upload-excel   → valida estructura, crea job  (estado: uploaded_excel)
2. POST /upload-images  → adjunta imágenes al job      (estado: uploaded_images)
3. POST /process/:jobId → ejecuta pipeline             (estado: processing → completed | failed)
4. GET  /processing-status/:jobId → consultar resultado
```

**Pasos internos del pipeline:**

| Paso | Nombre | Qué hace |
|---|---|---|
| A | validating_gtins | Valida check digit GS1 Mod-10 (EAN-8, UPC-12, EAN-13) |
| B | hashing | SHA-256 por imagen; descarta duplicados intra-lote e históricos |
| C | matching | Cruza nombre de archivo (`<GTIN>_sufijo.jpg`) con GTINs del Excel |
| D | hierarchy | Calcula ruta de blob según volumen por categoría vs. umbral |
| E | uploading | Sube imágenes (Azure o mock); falla el job si >50% fallan |
| F | persisting | Upsert en `RETSC_OP_PRODUCTS` + insert en `RETSC_LOG_IMAGE_UPLOAD` |
| G | ai_tracking | Registra necesidad de entrenamiento en `RETSC_AI_DETECTION_MODELS` |

El pipeline es **fire-and-forget**: `POST /process/:jobId` retorna de inmediato; el cliente consulta `/processing-status/:jobId` para saber el resultado.

---

## Blob storage: mock vs Azure

### Mock (default)
```env
BLOB_STORAGE_MODE=mock
BLOB_MOCK_BASE_PATH=data/blob-mock
```
Las imágenes se guardan en disco local. Se sirven en `/blob-mock/<ruta>`.

### Azure
```env
BLOB_STORAGE_MODE=azure
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
AZURE_BLOB_CONTAINER=retailscope-images
```
Las imágenes se suben al contenedor configurado. El cliente Azure se inicializa de forma lazy al primer upload.

---

## Datos de prueba

```bash
node scripts/create-test-data.js
```
Genera `test-data/products.xlsx` (5 GTINs válidos + 2 inválidos) y las imágenes de prueba correspondientes.
