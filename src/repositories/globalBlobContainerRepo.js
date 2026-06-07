// Repositorio para la tabla RETSC_INF_GLOBAL_BLOB_CONTAINERS.
// Registra los containers/prefijos de Azure Blob Storage asociados a categorías DTC.
//
// ESQUEMA REAL (verificado con INFORMATION_SCHEMA):
//   global_container_id  INT IDENTITY PK
//   category_id          INT NOT NULL
//   container_name       NVARCHAR(150) NOT NULL
//   container_type       VARCHAR(30)   NOT NULL  — CHK_RETSC_GLOBAL_BLOB_TYPE: 'GLOBAL_TRAINING' | 'GLOBAL_SKU_PHOTOS'
//   storage_account      NVARCHAR(150) NULL
//   description          NVARCHAR(300) NULL
//   status               TINYINT NOT NULL   ← NOT varchar; ver constantes abajo
//   created_at           DATETIME NOT NULL
//
// STATUS (tinyint):
//   1 = ACTIVE        — blob creado correctamente en Azure
//   0 = PENDING_AZURE — fallo al crear el blob, pendiente de retry
//
// NOTA TEMPORAL — columna 'prefix':
//   La columna dedicada `prefix VARCHAR(100)` está PENDIENTE de ser agregada
//   (contacto: María). Mientras tanto, el prefix se guarda dentro de `description`
//   con el formato: "prefix=dtc-shampoo | <descripción opcional>"
//   Ver helpers extractPrefixFromDescription() y buildDescription().
//
// TODO: migrar a columna 'prefix' cuando esté disponible:
//   - Agregar input('prefix', sql.VarChar(100), prefix) en insert()
//   - Cambiar findByName() para usar WHERE prefix = @prefix en SQL
//   - Eliminar extractPrefixFromDescription() y buildDescription()

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_INF_GLOBAL_BLOB_CONTAINERS';

// Constantes de status (tinyint en DB)
const STATUS = {
  ACTIVE:        1,
  PENDING_AZURE: 0,
};

// ─── Helpers internos ────────────────────────────────────────────────────────

// TEMPORAL: construye el campo description codificando el prefix dentro.
// Formato: "prefix=<valor> | <descripción adicional>" o solo "prefix=<valor>".
function buildDescription(prefix, extraDescription) {
  const base = `prefix=${prefix}`;
  // description es nvarchar(300); el resultado siempre cabe holgadamente
  return extraDescription ? `${base} | ${extraDescription}` : base;
}

// TEMPORAL: extrae el prefix del campo description.
// Devuelve null si no se encuentra el patrón esperado.
function extractPrefixFromDescription(description) {
  if (!description) return null;
  const match = description.match(/^prefix=([^\s|]+)/);
  return match ? match[1] : null;
}

// Convierte el tinyint de DB a un string legible internamente.
function decodeStatus(tinyintValue) {
  return tinyintValue === 1 ? 'ACTIVE' : 'PENDING_AZURE';
}

// ─── Lectura ─────────────────────────────────────────────────────────────────

// Devuelve el registro de container para una categoría, o null si no existe.
// NOTA: como container_name tiene UNIQUE constraint, una categoría tiene registro
// solo si fue la PRIMERA en registrar ese container. Ver findByContainerName().
const findByCategoryId = async (categoryId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int, categoryId)
    .query(`SELECT * FROM ${TABLE} WHERE category_id = @categoryId`);

  if (!r.recordset[0]) return null;
  const row = r.recordset[0];
  return { ...row, status: decodeStatus(row.status), prefix: extractPrefixFromDescription(row.description) };
};

// Devuelve el registro del container por su nombre (independiente de categoría).
// Usar esto para verificar si el container ya está registrado antes de insertar,
// ya que container_name tiene UNIQUE constraint (UQ_RETSC_GLOBAL_BLOB_CONTAINER_NAME).
const findByContainerName = async (containerName) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('containerName', sql.NVarChar(150), containerName)
    .query(`SELECT * FROM ${TABLE} WHERE container_name = @containerName`);

  if (!r.recordset[0]) return null;
  const row = r.recordset[0];
  return { ...row, status: decodeStatus(row.status), prefix: extractPrefixFromDescription(row.description) };
};

// Busca un registro por nombre de container raíz + prefix.
// El prefix se extrae del campo description (ver NOTA TEMPORAL arriba).
const findByName = async (containerName, prefix) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('containerName', sql.NVarChar(150), containerName)
    .query(`SELECT * FROM ${TABLE} WHERE container_name = @containerName`);

  // OPTIMIZAR: mover el filtro a SQL cuando exista la columna 'prefix'.
  const row = r.recordset.find(row => extractPrefixFromDescription(row.description) === prefix) ?? null;
  if (!row) return null;
  return { ...row, status: decodeStatus(row.status), prefix: extractPrefixFromDescription(row.description) };
};

// Devuelve todos los containers registrados para un array de category_ids.
const listByCategoryIds = async (categoryIds) => {
  if (!categoryIds || categoryIds.length === 0) return [];

  const pool = await getPool();
  const req = pool.request();
  const placeholders = categoryIds.map((id, i) => {
    req.input(`id${i}`, sql.Int, id);
    return `@id${i}`;
  });

  const r = await req.query(`SELECT * FROM ${TABLE} WHERE category_id IN (${placeholders.join(', ')})`);
  return r.recordset.map(row => ({
    ...row,
    status: decodeStatus(row.status),
    prefix: extractPrefixFromDescription(row.description),
  }));
};

// ─── Escritura ────────────────────────────────────────────────────────────────

// Inserta un nuevo registro de container global.
// status acepta 'ACTIVE' o 'PENDING_AZURE' (se convierte a tinyint internamente).
const insert = async ({ categoryId, containerName, containerType, storageAccount, prefix, description, status }) => {
  const pool = await getPool();

  // TEMPORAL: codificar prefix en description mientras no exista columna dedicada.
  const descValue = buildDescription(prefix, description);
  const statusInt = status === 'ACTIVE' ? STATUS.ACTIVE : STATUS.PENDING_AZURE;

  const r = await pool.request()
    .input('categoryId',     sql.Int,           categoryId)
    .input('containerName',  sql.NVarChar(150),  containerName)
    .input('containerType',  sql.VarChar(30),    containerType ?? 'training')
    .input('storageAccount', sql.NVarChar(150),  storageAccount ?? '')
    .input('description',    sql.NVarChar(300),  descValue)
    .input('status',         sql.TinyInt,        statusInt)
    .query(`
      INSERT INTO ${TABLE}
        (category_id, container_name, container_type, storage_account, description, status, created_at)
      OUTPUT INSERTED.*
      VALUES
        (@categoryId, @containerName, @containerType, @storageAccount, @description, @status, GETDATE())
    `);

  const row = r.recordset[0];
  return { ...row, status: decodeStatus(row.status), prefix };
};

// Actualiza el status de un registro (ej. PENDING_AZURE → ACTIVE después de reintentar).
// Acepta 'ACTIVE' o 'PENDING_AZURE'.
const updateStatus = async (globalContainerId, status) => {
  const statusInt = status === 'ACTIVE' ? STATUS.ACTIVE : STATUS.PENDING_AZURE;
  const pool = await getPool();
  const r = await pool.request()
    .input('id',     sql.Int,     globalContainerId)
    .input('status', sql.TinyInt, statusInt)
    .query(`
      UPDATE ${TABLE}
      SET status = @status
      OUTPUT INSERTED.*
      WHERE global_container_id = @id
    `);
  if (!r.recordset[0]) return null;
  const row = r.recordset[0];
  return { ...row, status: decodeStatus(row.status) };
};

module.exports = {
  findByCategoryId,
  findByContainerName,
  findByName,
  listByCategoryIds,
  insert,
  updateStatus,
  STATUS,
};
