// Repositorio para la tabla RETSC_AI_DETECTION_MODELS.
// Gestiona los modelos de Custom Vision por categoría DTC.
//
// ESQUEMA REAL DE LA TABLA (verificado con INFORMATION_SCHEMA):
//   detection_model_id        INT IDENTITY PK
//   category_id               INT NOT NULL
//   model_name                VARCHAR(100)  NULL
//   customvision_project_id   VARCHAR(100)  NULL  (hasta que Custom Vision esté configurado)
//   prediction_resource_id    VARCHAR(100)  NULL
//   status                    VARCHAR(20)   NULL  — ciclo real (más largo que el original):
//     PENDING → PROJECT_CREATED (8.1) → IMAGES_UPLOADED (8.2) → TRAINING → TRAINED | TRAINING_FAILED (8.3)
//     → READY (activo/publicado, 8.4) — más AWAITING_APPROVAL | REJECTED (8.5, re-entrenamiento) y ERROR
//     (fallo de provisioning inicial, no de training). TRAINED != READY: un modelo puede terminar de
//     entrenar sin estar publicado/activo todavía.
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

// ─── Versioning y re-entrenamiento (Issue 8.5) ────────────────────────────────

// Devuelve un modelo por su PK.
const findById = async (detectionModelId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, detectionModelId)
    .query(`SELECT * FROM ${TABLE} WHERE detection_model_id = @id`);
  return r.recordset[0] ?? null;
};

// Todas las versiones de una categoría, de la más nueva a la más vieja.
const listByCategory = async (categoryId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int, categoryId)
    .query(`
      SELECT * FROM ${TABLE}
      WHERE category_id = @categoryId
      ORDER BY model_version DESC
    `);
  return r.recordset;
};

// Mayor model_version registrada para una categoría (0 si no hay ninguna).
const getMaxVersion = async (categoryId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int, categoryId)
    .query(`SELECT ISNULL(MAX(model_version), 0) AS maxVersion FROM ${TABLE} WHERE category_id = @categoryId`);
  return r.recordset[0].maxVersion;
};

// Guarda las métricas de entrenamiento de una versión y marca trained_at.
// (migración 006: precision_score, recall_score, mean_ap, metrics_json)
const saveMetrics = async (detectionModelId, { precisionScore, recallScore, meanAp, metricsJson }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',        sql.Int,               detectionModelId)
    .input('precision', sql.Float,             precisionScore ?? null)
    .input('recall',    sql.Float,             recallScore ?? null)
    .input('meanAp',    sql.Float,             meanAp ?? null)
    .input('json',      sql.NVarChar(sql.MAX), metricsJson ?? null)
    .query(`
      UPDATE ${TABLE}
      SET precision_score = @precision,
          recall_score    = @recall,
          mean_ap         = @meanAp,
          metrics_json    = @json,
          trained_at      = GETDATE()
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  return r.recordset[0] ?? null;
};

// Activa una versión y desactiva las demás de la misma categoría (rollback/activación).
// NOTA: son dos UPDATEs secuenciales; para esta escala es suficiente. Si se requiriera
// atomicidad estricta ante concurrencia, envolver en una transacción mssql.
const setActiveVersion = async (categoryId, detectionModelId) => {
  const pool = await getPool();
  await pool.request()
    .input('categoryId', sql.Int, categoryId)
    .query(`UPDATE ${TABLE} SET is_active = 0 WHERE category_id = @categoryId`);

  const r = await pool.request()
    .input('id', sql.Int, detectionModelId)
    .query(`
      UPDATE ${TABLE}
      SET is_active = 1, status = 'READY'
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  return r.recordset[0] ?? null;
};

// Registra quién y cuándo aprobó manualmente una versión (métricas peores).
const setApproval = async (detectionModelId, adminId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',    sql.Int, detectionModelId)
    .input('admin', sql.Int, adminId ?? null)
    .query(`
      UPDATE ${TABLE}
      SET approved_by = @admin, approved_at = GETDATE()
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
  // Issue 8.5
  findById,
  listByCategory,
  getMaxVersion,
  saveMetrics,
  setActiveVersion,
  setApproval,
};
