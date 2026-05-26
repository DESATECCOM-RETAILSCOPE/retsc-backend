# retsc-backend

API REST para RetailScope — Node.js + Express.

## Persistencia temporal (JSON)

El backend usa persistencia temporal en archivos JSON bajo `/data` mientras se define el acceso a SQL Server.

La migración a SQL es transparente para los clientes del API: solo se reemplaza la implementación interna de cada módulo en `src/repositories/`. Las firmas de los repositorios no deben cambiarse en esa migración.

## Cómo arrancar

```bash
npm install
cp .env.example .env        # completar variables (ver sección de entorno)
npm run seed                 # genera usuario y empresa demo
npm run dev                  # servidor con auto-reload
```

## Credenciales del seed

| Campo    | Valor                      |
|----------|----------------------------|
| Email    | admin@retailscope.com      |
| Password | demo1234                   |

## Variables de entorno

| Variable                       | Descripción                                               |
|--------------------------------|-----------------------------------------------------------|
| PORT                           | Puerto del servidor (default 3000)                        |
| JWT_SECRET                     | Clave de firma de tokens                                  |
| JWT_EXPIRES_IN                 | Tiempo de expiración (default `24h`)                      |
| DB_SERVER                      | SQL Server host (inactivo por ahora)                      |
| DB_NAME                        | Nombre de base de datos                                   |
| DB_USER                        | Usuario SQL                                               |
| DB_PASSWORD                    | Contraseña SQL                                            |
| BLOB_STORAGE_MODE              | `mock` (local) o `azure` (Azure Blob Storage)             |
| BLOB_MOCK_BASE_PATH            | Carpeta base para el mock local (default `data/blob-mock`)|
| AZURE_STORAGE_CONNECTION_STRING| Connection string de Azure (solo si `BLOB_STORAGE_MODE=azure`) |
| AZURE_BLOB_CONTAINER           | Nombre del contenedor Azure (default `retailscope-images`)|
| BLOB_HIERARCHY_THRESHOLD       | Productos por categoría para aumentar profundidad de ruta (default 500) |

## Endpoints disponibles

### Autenticación

| Método | Ruta                   | Auth   | Descripción                  |
|--------|------------------------|--------|------------------------------|
| POST   | /api/auth/register     | No     | Crear nuevo usuario          |
| POST   | /api/auth/login        | No     | Iniciar sesión (JWT)         |
| GET    | /api/auth/me           | Bearer | Datos del usuario actual     |
| GET    | /api/auth/users        | Bearer | Lista de todos los usuarios  |

### Empresas

| Método | Ruta                              | Auth   | Descripción                               |
|--------|-----------------------------------|--------|-------------------------------------------|
| POST   | /api/enterprises                  | No     | Crear empresa + usuario admin en cascada  |
| GET    | /api/enterprises/me/categories    | Bearer | Categorías asignadas a la empresa         |
| PUT    | /api/enterprises/me/categories    | Bearer | Reemplazar categorías de la empresa       |

### Usuarios

| Método | Ruta                                         | Auth   | Descripción                              |
|--------|----------------------------------------------|--------|------------------------------------------|
| GET    | /api/users                                   | Bearer | Listar usuarios de la empresa            |
| GET    | /api/users/by-cedula/:ced                    | Bearer | Buscar usuario por cédula                |
| POST   | /api/users                                   | Bearer | Crear usuario y asignarlo a la empresa   |
| POST   | /api/users/assign                            | Bearer | Asignar usuario existente a la empresa   |
| PUT    | /api/users/:id                               | Bearer | Actualizar datos del usuario             |
| PUT    | /api/users/:userId/enterprises/:enterpriseId | Bearer | Actualizar relación usuario-empresa      |

### Categorías

| Método | Ruta            | Auth   | Descripción               |
|--------|-----------------|--------|---------------------------|
| GET    | /api/categories | Bearer | Listar categorías globales |

### Artículos (pipeline de carga)

| Método | Ruta                                        | Auth   | Descripción                              |
|--------|---------------------------------------------|--------|------------------------------------------|
| POST   | /api/products/upload-excel                  | Bearer | Subir Excel con lista de productos       |
| POST   | /api/products/upload-images                 | Bearer | Subir imágenes para un job               |
| POST   | /api/products/process/:jobId                | Bearer | Ejecutar pipeline de procesamiento       |
| GET    | /api/products/processing-status/:jobId      | Bearer | Consultar estado y métricas del job      |
| GET    | /api/products                               | Bearer | Listar productos de la empresa           |

---

### Ejemplo de login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@retailscope.com","password":"demo1234"}'
```

```json
{
  "token": "<jwt>",
  "user": {
    "userId": 1,
    "email": "admin@retailscope.com",
    "username": "Admin Demo",
    "enterpriseId": 1,
    "roleId": 1,
    "roleName": "Admin"
  }
}
```

---

## Módulo de artículos — guía completa

### Flujo del pipeline

```
1. POST /upload-excel   → valida estructura, crea job (estado: uploaded_excel)
2. POST /upload-images  → sube imágenes al job       (estado: uploaded_images)
3. POST /process/:jobId → ejecuta pipeline           (estado: processing → completed | failed)
4. GET  /processing-status/:jobId → consultar estado y métricas
```

El pipeline es **síncrono**: el paso 3 bloquea hasta completar y devuelve el resultado en la misma respuesta.

---

### POST /api/products/upload-excel

Sube un archivo `.xlsx` o `.xls` con la lista de productos.

**Columnas requeridas** (case-insensitive, acepta tildes): `GTIN`, `Description`/`Descripción`, `Category`/`Categoría`

**Columnas opcionales**: `Subcategory`/`Subcategoría`, `Segment`/`Segmento`, `Brand`/`Marca`

```bash
curl -X POST http://localhost:3000/api/products/upload-excel \
  -H "Authorization: Bearer <token>" \
  -F "file=@products.xlsx"
```

```json
{
  "success": true,
  "jobId": "dc44fa94-d85b-438b-85e2-b73ebd41fdaa",
  "totalRows": 7,
  "structuralErrors": [],
  "rowErrors": []
}
```

`rowErrors` lista GTINs vacíos o duplicados dentro del Excel (no bloquean la carga; el pipeline los rechaza individualmente).

---

### POST /api/products/upload-images

Adjunta imágenes a un job ya creado.

**Regla de nombres**: el archivo debe llamarse `<GTIN>.jpg` (o `<GTIN>_sufijo.jpg`). El GTIN extraído del nombre se usa para hacer el matching con el Excel.

```bash
curl -X POST http://localhost:3000/api/products/upload-images \
  -H "Authorization: Bearer <token>" \
  -F "jobId=dc44fa94-d85b-438b-85e2-b73ebd41fdaa" \
  -F "files=@7501031311309.jpg" \
  -F "files=@7501031318100.jpg" \
  -F "files=@036000291452.jpg"
```

```json
{
  "success": true,
  "jobId": "dc44fa94-d85b-438b-85e2-b73ebd41fdaa",
  "totalImages": 3,
  "invalidFilenames": []
}
```

`invalidFilenames` lista archivos cuyo nombre no contiene un GTIN válido (8, 12 o 13 dígitos); se ignoran en el pipeline.

---

### POST /api/products/process/:jobId

Ejecuta el pipeline completo sobre el job. El job debe estar en estado `uploaded_images`.

**Pasos internos:**
- **A — Validación GTIN**: algoritmo GS1 Mod 10 (EAN-8, UPC-12, EAN-13)
- **B — Hash y deduplicación**: SHA-256 por imagen; descarta duplicados intra-lote y contra historial de la empresa
- **C — Matching**: cruza nombre de archivo con GTIN del Excel; un producto acepta solo una imagen
- **D — Jerarquía**: calcula la ruta de blob según volumen de productos por categoría
- **E — Upload**: sube imágenes al blob storage (mock o Azure)
- **F — Persistencia**: inserta productos e imágenes en los JSON; saltea GTINs que ya existen para la empresa
- **G — AI tracking**: registra necesidad de entrenamiento por categorías nuevas

```bash
curl -X POST http://localhost:3000/api/products/process/dc44fa94-d85b-438b-85e2-b73ebd41fdaa \
  -H "Authorization: Bearer <token>"
```

```json
{
  "success": true,
  "jobId": "dc44fa94-d85b-438b-85e2-b73ebd41fdaa",
  "status": "completed",
  "metrics": {
    "totalRows": 7,
    "validGtins": 5,
    "invalidGtins": [
      { "gtin": "7501031311300", "reason": "Dígito verificador inválido" },
      { "gtin": "1234567890123", "reason": "Dígito verificador inválido" }
    ],
    "totalImages": 4,
    "duplicateImages": [],
    "unmatchedImages": ["9999999999999_extra.jpg"],
    "productsWithoutImage": ["96385074", "7501234567893"],
    "uploaded": 3,
    "inserted": 3
  }
}
```

El job pasa a `failed` si: todos los GTINs son inválidos, ninguna imagen hace match, o más del 50% de los uploads fallan.

---

### GET /api/products/processing-status/:jobId

Devuelve el estado actual del job sin el contenido completo del Excel ni la lista de archivos.

```bash
curl http://localhost:3000/api/products/processing-status/dc44fa94-d85b-438b-85e2-b73ebd41fdaa \
  -H "Authorization: Bearer <token>"
```

```json
{
  "success": true,
  "jobId": "dc44fa94-d85b-438b-85e2-b73ebd41fdaa",
  "status": "completed",
  "currentStep": null,
  "metrics": { "...": "..." },
  "excelRowCount": 7,
  "imageFileCount": 4,
  "createdDate": "2026-05-20T19:05:57.067Z",
  "updatedDate": "2026-05-20T19:07:01.934Z",
  "errorMessage": null
}
```

Estados posibles: `uploaded_excel` → `uploaded_images` → `processing` → `completed` | `failed`

---

### GET /api/products

Lista los productos de la empresa autenticada con paginación.

```bash
curl "http://localhost:3000/api/products?page=1&limit=20&search=chips&categoryId=3" \
  -H "Authorization: Bearer <token>"
```

```json
{
  "success": true,
  "products": [
    {
      "Product_id": 2,
      "GTIN": "7501031318100",
      "Description": "Chips Chile Limón 100g",
      "Category_name": "Snacks",
      "Subcategory": "Papas Fritas",
      "Segment": "Chile",
      "Brand": "Barcel",
      "Primary_image_url": "data/blob-mock/snacks/7501031318100.jpg",
      "primaryImage": "data/blob-mock/snacks/7501031318100.jpg",
      "imageCount": 1,
      "Status": 1
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

Parámetros opcionales: `page` (default 1), `limit` (default 50), `search` (busca en descripción y GTIN), `categoryId`.

---

## Datos de prueba

Para generar el Excel y las imágenes de prueba bajo `test-data/`:

```bash
node scripts/create-test-data.js
```

Genera:
- `test-data/products.xlsx` — 5 GTINs válidos + 2 inválidos
- `test-data/images/7501031311309.jpg` — imagen con match
- `test-data/images/7501031318100.jpg` — imagen con match
- `test-data/images/036000291452.jpg` — imagen con match
- `test-data/images/9999999999999_extra.jpg` — imagen sin match (GTIN no está en el Excel)

Con estos datos se pueden probar todos los casos del pipeline: GTINs inválidos, imágenes sin match, productos sin imagen y deduplicación histórica.

---

## Blob storage: modo mock vs Azure

### Modo mock (default)

```env
BLOB_STORAGE_MODE=mock
BLOB_MOCK_BASE_PATH=data/blob-mock
```

Las imágenes se guardan en disco local bajo `data/blob-mock/<ruta-jerarquica>/`. La URL almacenada en `images.json` es la ruta relativa al proyecto.

### Modo Azure

```env
BLOB_STORAGE_MODE=azure
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
AZURE_BLOB_CONTAINER=retailscope-images
```

Las imágenes se suben al contenedor configurado. La URL almacenada es la URL pública del blob.

### Jerarquía de rutas

El pipeline calcula la profundidad de la ruta según el volumen de productos de la empresa por categoría:

| Condición (productos existentes + lote actual) | Ruta generada                        |
|------------------------------------------------|--------------------------------------|
| Total en categoría < umbral                    | `<categoria>/`                       |
| Total en categoría ≥ umbral                    | `<categoria>/<subcategoria>/`        |
| Total en subcategoría ≥ umbral (anidado)       | `<categoria>/<subcategoria>/<segmento>/` |

El umbral se controla con `BLOB_HIERARCHY_THRESHOLD` (default 500).

---

## Archivos JSON afectados por el pipeline

| Archivo                  | Qué se escribe                                           |
|--------------------------|----------------------------------------------------------|
| `data/load_states.json`  | Un registro por job con estado, métricas y referencias   |
| `data/products.json`     | Un registro por producto nuevo (GTIN + empresa únicos)   |
| `data/images.json`       | Un registro por imagen subida con hash SHA-256 y URL     |
| `data/ai_models.json`    | Crea o incrementa `Pending_images_count` por categoría   |

Los archivos `data/users.json`, `data/enterprises.json` y `data/usrsxenterp.json` no son tocados por el pipeline de artículos.

---

## Cómo conectar Azure cuando lleguen las credenciales

1. **Obtener la connection string** desde el portal de Azure → Storage Account → Access keys → Connection string.

2. **Actualizar `.env`**:
   ```env
   BLOB_STORAGE_MODE=azure
   AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=<cuenta>;AccountKey=<clave>;EndpointSuffix=core.windows.net
   AZURE_BLOB_CONTAINER=retailscope-images
   ```

3. **Crear el contenedor** en Azure si no existe (portal o CLI):
   ```bash
   az storage container create \
     --name retailscope-images \
     --connection-string "<connection-string>" \
     --public-access blob
   ```

4. **Reiniciar el servidor**. El cliente Azure se inicializa de forma lazy al primer upload; no hay cambio de código.

5. **Migrar imágenes del mock** (opcional): las URLs en `data/images.json` y `data/products.json` seguirán apuntando a rutas locales para registros históricos. Los nuevos uploads ya irán a Azure. Si se necesita migrar los registros anteriores, actualizar los campos `Blob_url` / `Primary_image_url` con las URLs de Azure tras subir los archivos manualmente.

> El archivo `src/services/blobStorageService.js` contiene toda la lógica de switch entre modos. No es necesario modificar ningún otro archivo al cambiar de mock a Azure.

---

## Cómo migrar a SQL más adelante

Cuando SQL Server esté disponible, solo hay que reemplazar el contenido de `src/repositories/*.js`. Cada repositorio deberá:

1. Importar `../config/db` en lugar de `./jsonRepo`.
2. Implementar los mismos métodos con las mismas firmas (mismo nombre, mismos parámetros, mismo tipo de retorno).
3. Las capas superiores (services, controllers, routes) no necesitan ningún cambio.

`src/config/db.js` ya existe y configura el pool de MSSQL — solo hay que activarlo.

## Estructura de directorios

```
data/               Archivos JSON de persistencia temporal
scripts/
  seed.js           Genera datos iniciales (usuario + empresa demo)
  create-test-data.js  Genera Excel e imágenes de prueba
test-data/          Excel e imágenes generados por create-test-data.js
uploads-temp/       Directorio temporal para archivos en tránsito (limpiado automáticamente)
src/
  repositories/     Capa de acceso a datos (JSON hoy, SQL mañana)
  services/         Lógica de negocio y pipeline de artículos
  controllers/      Validación de entrada y formato de respuesta HTTP
  routes/           Definición de rutas Express
  middlewares/      Verificación JWT
  utils/            Validador GTIN (GS1 Mod 10), hasher de imágenes
  config/db.js      Pool MSSQL (inactivo, listo para reactivar)
```
