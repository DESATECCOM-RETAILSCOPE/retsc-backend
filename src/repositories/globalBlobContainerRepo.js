// Repositorio para la tabla RETSC_INF_GLOBAL_BLOB_CONTAINERS.
// Registra los containers/prefijos de Azure Blob Storage asociados a categorías DTC.
//
// ESQUEMA REAL (verificado con INFORMATION_SCHEMA):
//   global_container_id  INT IDENTITY PK
//   category_id          INT NOT NULL
//   container_name       NVARCHAR(150) NOT NULL  — nombre del container COMPARTIDO (ej. 'global-sku-training')
//   container_type       VARCHAR(30)   NOT NULL  — CHK_RETSC_GLOBAL_BLOB_TYPE: 'GLOBAL_TRAINING' | 'GLOBAL_SKU_PHOTOS'
//                                                   'GLOBAL_SKU_PHOTOS' → container global-sku-training (fotos de SKU)
//                                                   'GLOBAL_TRAINING'   → container global-shelf-training (fotos de góndola)
//   storage_account      NVARCHAR(150) NULL
//   prefix               VARCHAR(100)  NULL       — agregado en migración 003; identifica la categoría/canal dentro del container
//   description          NVARCHAR(300) NULL       — libre para uso futuro (descripción humana)
//   status               TINYINT NOT NULL   ← NOT varchar; ver constantes abajo
//   created_at           DATETIME NOT NULL
//
// STATUS (tinyint):
//   1 = ACTIVE        — blob creado correctamente en Azure
//   0 = PENDING_AZURE — fallo al crear el blob, pendiente de retry
//
// UNIQUE (migración 007): (container_name, prefix) — antes era solo container_name, lo
// que impedía que más de una categoría quedara registrada por container compartido.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_INF_GLOBAL_BLOB_CONTAINERS';

// Constantes de status (tinyint en DB)
const STATUS = {
  ACTIVE:        1,
  PENDING_AZURE: 0,
};

// ─── Helpers internos ────────────────────────────────────────────────────────

// Convierte el tinyint de DB a un string legible internamente.
function decodeStatus(tinyintValue) {
  return tinyintValue === 1 ? 'ACTIVE' : 'PENDING_AZURE';
}

function toDTO(row) {
  return { ...row, status: decodeStatus(row.status) };
}

// ─── Lectura ─────────────────────────────────────────────────────────────────

// Devuelve el registro de container para una categoría, o null si no existe.
// Desde la migración 007 cada categoría registra su propia fila (container_name, prefix
// es la combinación única), así que category_id ya no está limitado a "la primera que
// llegó" — pero una categoría puede tener MÁS DE UNA fila si provisiona en más de un
// container (ej. una en global-sku-training y otras en global-shelf-training por canal);
// este helper devuelve solo la primera que encuentre, no pensado para ese caso.
const findByCategoryId = async (categoryId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int, categoryId)
    .query(`SELECT * FROM ${TABLE} WHERE category_id = @categoryId`);

  if (!r.recordset[0]) return null;
  return toDTO(r.recordset[0]);
};

// Devuelve el registro del container por su nombre (independiente de categoría).
// NOTA (migración 007): ya no sirve para chequear idempotencia antes de insertar —
// el UNIQUE constraint pasó de container_name solo a (container_name, prefix), porque
// container_name es el nombre del container COMPARTIDO entre categorías (ej.
// 'global-sku-training'), no algo único por categoría. Usar findByName() para el
// chequeo de "ya existe esta combinación" antes de insertar.
const findByContainerName = async (containerName) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('containerName', sql.NVarChar(150), containerName)
    .query(`SELECT * FROM ${TABLE} WHERE container_name = @containerName`);

  if (!r.recordset[0]) return null;
  return toDTO(r.recordset[0]);
};

// Busca un registro por nombre de container raíz + prefix.
const findByName = async (containerName, prefix) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('containerName', sql.NVarChar(150), containerName)
    .input('prefix',        sql.VarChar(100),  prefix)
    .query(`SELECT * FROM ${TABLE} WHERE container_name = @containerName AND prefix = @prefix`);

  if (!r.recordset[0]) return null;
  return toDTO(r.recordset[0]);
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
  return r.recordset.map(toDTO);
};

// ─── Escritura ────────────────────────────────────────────────────────────────

// Inserta un nuevo registro de container global.
// status acepta 'ACTIVE' o 'PENDING_AZURE' (se convierte a tinyint internamente).
// description queda libre para uso futuro (descripción humana); se inserta como NULL si no se pasa.
const insert = async ({ categoryId, containerName, containerType, storageAccount, prefix, description, status }) => {
  const pool = await getPool();
  const statusInt = status === 'ACTIVE' ? STATUS.ACTIVE : STATUS.PENDING_AZURE;

  const r = await pool.request()
    .input('categoryId',     sql.Int,           categoryId)
    .input('containerName',  sql.NVarChar(150),  containerName)
    .input('containerType',  sql.VarChar(30),    containerType ?? 'training')
    .input('storageAccount', sql.NVarChar(150),  storageAccount ?? '')
    .input('prefix',         sql.VarChar(100),   prefix ?? null)
    .input('description',    sql.NVarChar(300),  description ?? null)
    .input('status',         sql.TinyInt,        statusInt)
    .query(`
      INSERT INTO ${TABLE}
        (category_id, container_name, container_type, storage_account, prefix, description, status, created_at)
      OUTPUT INSERTED.*
      VALUES
        (@categoryId, @containerName, @containerType, @storageAccount, @prefix, @description, @status, GETDATE())
    `);

  return toDTO(r.recordset[0]);
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
  return toDTO(r.recordset[0]);
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
