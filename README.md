# RetailScope Backend

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
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Firma y duración del access token (default `1h`) |
| `JWT_REFRESH_SECRET` / `JWT_REFRESH_EXPIRES_IN` | Firma y duración del refresh token (default `30d`) |
| `BLOB_STORAGE_MODE` | `mock` (local) o `azure` |
| `BLOB_MOCK_BASE_PATH` | Carpeta para mock local (default `data/blob-mock`) |
| `AZURE_STORAGE_CONNECTION_STRING` | Solo si `BLOB_STORAGE_MODE=azure` |
| `AZURE_BLOB_CONTAINER` | Nombre del contenedor Azure (default `retailscope-images`) |
| `BLOB_HIERARCHY_THRESHOLD` | Umbral de productos para aumentar profundidad de ruta (default 500) |
| `SMTP_HOST` | Servidor SMTP; vacío = modo mock (imprime el email en consola) |
| `SMTP_PORT` / `SMTP_SECURE` | Puerto y TLS del SMTP (default 587 / false) |
| `SMTP_USER` / `SMTP_PASS` | Credenciales SMTP |
| `SMTP_FROM` | Dirección remitente |

## Endpoints

### Auth — `/api/auth`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/login` | No | Inicia sesión. Devuelve `accessToken`, `refreshToken` y `user` (incluye `enterpriseDsc`) |
| POST | `/refresh` | No | Renueva el `accessToken` con un `refreshToken` válido |
| POST | `/logout` | No | Cierre de sesión (stateless) |
| POST | `/register` | No | Registra un usuario |
| POST | `/forgot-password` | No | Genera nueva contraseña y la envía al email. Body: `{ identifier }` (email o username) |
| GET | `/me` | Bearer | Datos del usuario autenticado |
| GET | `/users` | Bearer | Lista todos los usuarios |

### Empresas — `/api/enterprises`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/` | No | Registra empresa + usuario administrador (genera password automático) |
| GET | `/` | Bearer + Admin | Lista todas las empresas |
| GET | `/list` | Bearer + Admin | Alias de `GET /` |
| GET | `/:id` | Bearer + Admin | Detalle de empresa |
| POST | `/create` | Bearer + Admin | Crea empresa sin crear usuario administrador |
| PUT | `/:id` | Bearer + Admin | Edita empresa. Acepta `status` (0/1) para activar/desactivar |

El campo `type` debe ser uno de: `"Proveedor"`, `"Detallista"`, `"Empresa de servicios"`.

### Usuarios — `/api/users`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/` | Bearer | Usuarios de la empresa autenticada |
| GET | `/by-cedula/:ced` | Bearer | Busca usuario por cédula |
| POST | `/` | Bearer | Crea usuario y lo asigna a la empresa |
| POST | `/assign` | Bearer | Asigna usuario existente a la empresa |
| PUT | `/:id` | Bearer | Actualiza datos del usuario |
| PUT | `/:userId/enterprises/:enterpriseId` | Bearer | Actualiza relación usuario-empresa (rol, status) |

### Roles — `/api/roles`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/` | Bearer | Lista todos los roles |
| GET | `/:id` | Bearer | Detalle de rol |
| POST | `/` | Bearer | Crea rol |
| PUT | `/:id` | Bearer | Edita rol |
| PATCH | `/:id/status` | Bearer | Activa/desactiva rol |

### Categorías — `/api/categories`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/` | Bearer | Árbol completo de categorías activas |
| GET | `/roots` | Bearer | Solo categorías raíz |
| GET | `/:id/children` | Bearer | Hijos directos de una categoría |
| GET | `/:id` | Bearer | Detalle de categoría |
| POST | `/` | Bearer | Crea categoría |
| PUT | `/:id` | Bearer | Edita categoría |
| DELETE | `/:id` | Bearer | Soft-delete con cascada a subcategorías |

### Categorías de empresa — `/api/enterprises/me/categories`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/` | Bearer | Categorías seleccionadas por la empresa |
| PUT | `/` | Bearer | Reemplaza atómicamente las categorías de la empresa |

### Productos — `/api/products`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/` | Bearer | Lista productos con paginación y búsqueda |
| POST | `/upload-excel` | Bearer | Sube y parsea `.xlsx`; devuelve filas y errores |
| POST | `/upload-images` | Bearer | Sube hasta 200 imágenes al job temporal |
| POST | `/process/:jobId` | Bearer | Inicia el pipeline de ingesta (fire-and-forget) |
| GET | `/processing-status/:jobId` | Bearer | Estado del pipeline |

### Salud

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/health` | No | `{ status: "OK", timestamp }` |

---

## Flujo de autenticación

```
POST /api/auth/login  { email, password }
  → { accessToken, refreshToken, token (legacy), user: { ..., enterpriseDsc } }

POST /api/auth/refresh  { refreshToken }
  → { accessToken }

POST /api/auth/forgot-password  { identifier }   ← email o username
  → genera nueva contraseña, la guarda en BD y la envía por email
  → respuesta siempre genérica (no revela si el usuario existe)
```

El `accessToken` expira en 1h. El campo `user.enterpriseDsc` viene en el login para que el frontend pueda mostrar el nombre de la empresa sin un fetch adicional.

---

## Pipeline de ingesta de productos

```
1. POST /upload-excel   → valida estructura, crea job  (estado: uploaded_excel)
2. POST /upload-images  → adjunta imágenes al job      (estado: uploaded_images)
3. POST /process/:jobId → dispara pipeline             (estado: processing → completed | failed)
4. GET  /processing-status/:jobId → consultar resultado
```

**Pasos internos:**

| Paso | Nombre | Qué hace |
|---|---|---|
| A | validating_gtins | Valida check-digit GS1 Mod-10 (EAN-8, UPC-12, EAN-13) |
| B | hashing | SHA-256 por imagen; descarta duplicados intra-lote e históricos |
| C | matching | Cruza nombre de archivo (`<GTIN>_sufijo.jpg`) con GTINs del Excel |
| D | hierarchy | Calcula ruta de blob según volumen por categoría vs. umbral |
| E | uploading | Sube imágenes en lotes de 10 con retry exponencial; falla si >50% fallan |
| F | persisting | Insert en `RETSC_LOG_IMAGE_UPLOAD` (pipeline legacy, no funcional — ver CLAUDE.md) |
| G | ai_tracking | Registra necesidad de entrenamiento en `RETSC_AI_DETECTION_MODELS` |

---

## Blob storage: mock vs Azure

### Mock (default)
```env
BLOB_STORAGE_MODE=mock
BLOB_MOCK_BASE_PATH=data/blob-mock
```
Las imágenes se guardan en disco local y se sirven en `/blob-mock/<ruta>`.

### Azure
```env
BLOB_STORAGE_MODE=azure
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
AZURE_BLOB_CONTAINER=retailscope-images
```

---

## Email: mock vs SMTP

### Mock (default — SMTP_HOST vacío)
La nueva contraseña se imprime en la consola del servidor. No se envía ningún email real.

### SMTP real
```env
# Gmail
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu@gmail.com
SMTP_PASS=tu_app_password
SMTP_FROM=no-reply@retailscope.com

# Outlook
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
```

---

## Datos de prueba

```bash
node scripts/create-test-data.js
```
Genera `test-data/products.xlsx` (5 GTINs válidos + 2 inválidos) y las imágenes de prueba correspondientes.
