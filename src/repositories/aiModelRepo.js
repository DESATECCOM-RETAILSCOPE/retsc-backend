// Repositorio para la tabla RETSC_AI_DETECTION_MODELS.
// Gestiona los modelos de Custom Vision por categoría DTC.
//
// ESQUEMA REAL DE LA TABLA (verificado con INFORMATION_SCHEMA):
//   detection_model_id        INT IDENTITY PK
//   category_id               INT NOT NULL
//   model_name                VARCHAR(100)  NULL
//   customvision_project_id   VARCHAR(100)  NULL  (hasta que Custom Vision esté configurado)
//   prediction_resource_id    VARCHAR(100)  NULL
//   status                    VARCHAR(20)   NULL  — 'PENDING' | 'TRAINING' | 'READY' | 'ERROR'
//   trained_at                DATETIME      NULL
//   created_at                DATETIME      NULL
//   model_version             INT           NULL
//   last_publish_name         VARCHAR(100)  NULL
//   confidence_threshold      DECIMAL(18,x) NOT NULL
//   is_active                 BIT           NULL
//
// NOTA: el repo anterior usaba nombres Pascal_Case (Category_id, Model_id, Status, etc.)
// que no coincidían con la tabla real. Este reemplazo usa los nombres reales.
// aiService.js fue actualizado en consecuencia.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_AI_DETECTION_MODELS';

// ─── Lectura ─────────────────────────────────────────────────────────────────

// Devuelve el modelo activo de una categoría, o null si no existe.
const findByCategoryId = async (categoryId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int, categoryId)
    .query(`
      SELECT * FROM ${TABLE}
      WHERE category_id = @categoryId
        AND is_active = 1
    `);
  return r.recordset[0] ?? null;
};

// Devuelve todos los modelos (activos e inactivos). Usado en aiService para buscar por categoría.
const listAll = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`SELECT * FROM ${TABLE}`);
  return r.recordset;
};

// Devuelve modelos para un array de category_ids.
const listByCategoryIds = async (categoryIds) => {
  if (!categoryIds || categoryIds.length === 0) return [];

  const pool = await getPool();
  const req = pool.request();
  const placeholders = categoryIds.map((id, i) => {
    req.input(`id${i}`, sql.Int, id);
    return `@id${i}`;
  });

  const r = await req.query(`
    SELECT * FROM ${TABLE}
    WHERE category_id IN (${placeholders.join(', ')})
  `);
  return r.recordset;
};

// ─── Escritura ────────────────────────────────────────────────────────────────

// Inserta un nuevo modelo placeholder.
// customvisionProjectId y predictionResourceId quedan NULL hasta que Custom Vision esté configurado.
// Tipos reales verificados con INFORMATION_SCHEMA:
//   model_name / customvision_project_id / prediction_resource_id → varchar(100)
//   status          → varchar(20)
//   confidence_threshold → decimal
//   is_active       → bit (nullable)
//   created_at / trained_at → datetime (no datetime2)
const insert = async ({
  categoryId,
  modelName,
  customvisionProjectId = null,
  predictionResourceId  = null,
  status                = 'PENDING',
  modelVersion          = 1,
  confidenceThreshold   = 0.5,
  isActive              = 1,
}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId',            sql.Int,          categoryId)
    .input('modelName',             sql.VarChar(100),  modelName)
    .input('customvisionProjectId', sql.VarChar(100),  customvisionProjectId)
    .input('predictionResourceId',  sql.VarChar(100),  predictionResourceId)
    .input('status',                sql.VarChar(20),   status)
    .input('modelVersion',          sql.Int,           modelVersion)
    .input('confidenceThreshold',   sql.Decimal(18,4), confidenceThreshold)
    .input('isActive',              sql.Bit,           isActive)
    .query(`
      INSERT INTO ${TABLE}
        (category_id, model_name, customvision_project_id, prediction_resource_id,
         status, model_version, confidence_threshold, is_active, created_at)
      OUTPUT INSERTED.*
      VALUES
        (@categoryId, @modelName, @customvisionProjectId, @predictionResourceId,
         @status, @modelVersion, @confidenceThreshold, @isActive, GETDATE())
    `);
  return r.recordset[0];
};

// Actualiza las referencias de Custom Vision una vez que el proyecto fue creado.
// Se llama desde aiInfrastructureService cuando las credenciales están disponibles.
const updateCustomVisionRefs = async (detectionModelId, { customvisionProjectId, predictionResourceId }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',                    sql.Int,          detectionModelId)
    .input('customvisionProjectId', sql.VarChar(100),  customvisionProjectId ?? null)
    .input('predictionResourceId',  sql.VarChar(100),  predictionResourceId  ?? null)
    .query(`
      UPDATE ${TABLE}
      SET customvision_project_id = @customvisionProjectId,
          prediction_resource_id  = @predictionResourceId
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  return r.recordset[0] ?? null;
};

// Cambia el status del modelo (PENDING → TRAINING → READY, etc.).
const updateStatus = async (detectionModelId, status) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',     sql.Int,        detectionModelId)
    .input('status', sql.VarChar(20), status)
    .query(`
      UPDATE ${TABLE}
      SET status = @status
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  return r.recordset[0] ?? null;
};

module.exports = {
  findByCategoryId,
  listAll,
  listByCategoryIds,
  insert,
  updateCustomVisionRefs,
  updateStatus,
};
