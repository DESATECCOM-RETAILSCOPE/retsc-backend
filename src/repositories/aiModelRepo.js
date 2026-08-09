// Repositorio para la tabla RETSC_AI_DETECTION_MODELS.
// Gestiona los modelos de Custom Vision por categoría DTC.
//
// ESQUEMA REAL DE LA TABLA (verificado con INFORMATION_SCHEMA):
//   detection_model_id        INT IDENTITY PK
//   category_id               INT NOT NULL
//   model_name                VARCHAR(100)  NULL
//   customvision_project_id   VARCHAR(100)  NULL  (hasta que Custom Vision esté configurado)
//   prediction_resource_id    VARCHAR(200)  NULL  (ampliada desde VARCHAR(100) el 2026-08-04 —
//     un Resource ID de ARM completo mide ~157 caracteres, ver aiInfrastructureService.js)
//   status                    VARCHAR(20)   NULL  — ciclo real (más largo que el original):
//     PENDING → PROJECT_CREATED (8.1) → IMAGES_UPLOADED (8.2) → TRAINING → TRAINED | TRAINING_FAILED (8.3)
//     → PUBLISHED (activo/publicado, 8.4/cableado 2026-08-03 — renombrado desde READY para
//     coincidir con el nombre de estado de la spec v1.4) y ERROR (fallo de provisioning
//     inicial, no de training). TRAINED != PUBLISHED: un modelo puede terminar de entrenar sin
//     estar publicado/activo todavía (p. ej. si la publicación real en Custom Vision falla por
//     falta de un prediction_resource_id válido — ver modelTrainingService.js).
//     RETIRADO 2026-08-03 (decisión de jefatura — ver docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md):
//     ya NO existen los estados AWAITING_APPROVAL/REJECTED ni la aprobación humana que los producía
//     (setApproval() eliminado de este repo; approveVersion/rejectVersion eliminados de
//     modelVersioningService.js). La spec v1.4 exige publicación 100% automática, sin gate de
//     métricas ni aprobación manual — cableado en modelTrainingService.handleTrainingCompleted()
//     y annotationSyncService.checkAndUpdateThreshold() (disparo automático por umbral, 4.3).
//   trained_at                DATETIME      NULL
//   created_at                DATETIME      NULL
//   model_version             INT           NULL
//   last_publish_name         VARCHAR(100)  NULL
//   confidence_threshold      DECIMAL(18,x) NOT NULL
//   is_active                 BIT           NULL
//   last_training_error       VARCHAR(500)  NULL  (migración 009, 2026-08-08 — motivo del
//     último rechazo/fallo de Custom Vision al entrenar o publicar; se limpia en el próximo
//     éxito. Ver markTrainingFailed()/setTrainingError() y modelTrainingService.js)
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
//   model_name / customvision_project_id → varchar(100)
//   prediction_resource_id → varchar(200) (ampliada 2026-08-04 — ver aiInfrastructureService.js)
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
    .input('predictionResourceId',  sql.VarChar(200),  predictionResourceId)
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
    .input('predictionResourceId',  sql.VarChar(200),  predictionResourceId  ?? null)
    .query(`
      UPDATE ${TABLE}
      SET customvision_project_id = @customvisionProjectId,
          prediction_resource_id  = @predictionResourceId
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  return r.recordset[0] ?? null;
};

// Cambia el status del modelo (PENDING → TRAINING → PUBLISHED, etc.).
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
// status='PUBLISHED' (renombrado desde 'READY' 2026-08-03, cableado del flujo automático
// spec v1.4 — ver nota de cabecera). NOTA: son dos UPDATEs secuenciales; para esta escala es
// suficiente. Si se requiriera atomicidad estricta ante concurrencia, envolver en una
// transacción mssql.
const setActiveVersion = async (categoryId, detectionModelId) => {
  const pool = await getPool();
  await pool.request()
    .input('categoryId', sql.Int, categoryId)
    .query(`UPDATE ${TABLE} SET is_active = 0 WHERE category_id = @categoryId`);

  const r = await pool.request()
    .input('id', sql.Int, detectionModelId)
    .query(`
      UPDATE ${TABLE}
      SET is_active = 1, status = 'PUBLISHED'
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  return r.recordset[0] ?? null;
};

// Cableado 2026-08-03 (flujo automático spec v1.4) — marca `trained_at` de forma
// INDEPENDIENTE de `saveMetrics()`. Necesario porque `saveMetrics()` toca columnas de la
// migración 006 (precision_score/recall_score/mean_ap/metrics_json), que sigue sin aplicarse
// en la BD real (ver modelTrainingService.js) — si `saveMetrics()` falla por columna
// inexistente, `trained_at` nunca avanzaría, y el conteo "+15 fotos desde el último
// entrenamiento" (annotationSyncService.checkAndUpdateThreshold) quedaría roto (recontaría
// siempre desde el mismo baseline viejo, re-disparando training en cada foto nueva). Esta
// función se llama SIEMPRE que un training termina (Completed), tenga o no métricas
// persistibles.
// Fix 2026-08-09 — BUG encontrado verificando el flujo automático end-to-end: esta función
// (y markTrainingFailed/markPublished, más abajo) originalmente ponían `trained_at`/`status`/
// `model_version` y `last_training_error` en el MISMO UPDATE. Cuando la migración 009
// (last_training_error) no está aplicada — confirmado que sigue sin aplicarse en esta BD,
// 2026-08-09 — SQL Server rechaza la query ENTERA por columna inexistente ANTES de ejecutar
// nada, así que ni siquiera el campo crítico (trained_at/status/model_version) llegaba a
// escribirse, pese a que el comentario original decía que `markTrained` "SIEMPRE corre,
// independientemente de la migración 006" — cierto para esa migración, pero la 009 rompía la
// misma garantía por el mismo motivo. Más grave en `markPublished`: como esa llamada no está
// envuelta en try/catch en `modelTrainingService.publishAndActivate()`, el fallo se propagaba
// sin atrapar y `setActiveVersion()` (el swap que realmente marca PUBLISHED) nunca se ejecutaba
// — Custom Vision publicaba la iteración con éxito, pero el modelo se quedaba en TRAINED para
// siempre en SQL. Separado en dos UPDATEs: el campo crítico va solo (siempre corre), y el touch
// de `last_training_error` es un segundo UPDATE best-effort — si la migración 009 no está
// aplicada, falla en silencio (logueado) sin afectar el campo crítico.
const clearTrainingErrorBestEffort = async (detectionModelId) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, detectionModelId)
      .query(`UPDATE ${TABLE} SET last_training_error = NULL WHERE detection_model_id = @id`);
  } catch (err) {
    console.error(`[aiModelRepo] no se pudo limpiar last_training_error (¿falta la migración 009?) — detection_model_id=${detectionModelId}:`, err.message);
  }
};

const markTrained = async (detectionModelId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, detectionModelId)
    .query(`
      UPDATE ${TABLE}
      SET trained_at = GETDATE()
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  await clearTrainingErrorBestEffort(detectionModelId);
  return r.recordset[0] ?? null;
};

// Cableado 2026-08-08 — arregla el fallo silencioso encontrado al investigar por qué
// category_id=2 quedaba colgado en IMAGES_UPLOADED sin explicación: si Custom Vision rechaza
// trainProject() (ej. BadRequestDetectionTrainingValidationFailed — confirmado contra CV real,
// "Not enough images per tag for training"), o si pollTrainingStatus() detecta Failed/timeout/
// demasiados fallos de red consecutivos, el modelo pasa a TRAINING_FAILED CON el motivo
// persistido — antes solo quedaba un console.error que se perdía en los logs del proceso.
// TRAINING_FAILED no está en SKIP_THRESHOLD_STATUSES (annotationSyncService.js), así que el
// mecanismo de reintento automático (próxima foto sincronizada reevalúa el umbral) sigue
// funcionando sin cambios adicionales. Requiere migración 009 (last_training_error) — si no
// está aplicada, esta función lanza "Invalid column name" y el caller debe atraparlo (mismo
// patrón defensivo que aiModelRepo.saveMetrics()/migración 006).
const markTrainingFailed = async (detectionModelId, errorMessage) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, detectionModelId)
    .query(`
      UPDATE ${TABLE}
      SET status = 'TRAINING_FAILED'
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  await setTrainingErrorBestEffort(detectionModelId, errorMessage);
  return r.recordset[0] ?? null;
};

// Extraído para reusar entre markTrainingFailed y setTrainingError — ver la NOTA de
// clearTrainingErrorBestEffort arriba sobre por qué esto va en un UPDATE separado del campo
// crítico (status, en este caso). Best-effort: si la migración 009 no está aplicada, falla en
// silencio (logueado) — el campo crítico (status) ya se escribió antes de llamar a esto.
const setTrainingErrorBestEffort = async (detectionModelId, errorMessage) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id',    sql.Int,         detectionModelId)
      .input('error', sql.VarChar(500), errorMessage ? String(errorMessage).slice(0, 500) : null)
      .query(`UPDATE ${TABLE} SET last_training_error = @error WHERE detection_model_id = @id`);
  } catch (err) {
    console.error(`[aiModelRepo] no se pudo persistir last_training_error (¿falta la migración 009?) — detection_model_id=${detectionModelId}:`, err.message);
  }
};

// Variante que NO cambia el status — usada cuando el training SÍ completó pero la publicación
// automática falla (ver modelTrainingService.publishAndActivate): el modelo debe quedar en
// TRAINED (entrenado, no publicado), no en TRAINING_FAILED, pero el motivo del rechazo de
// publishIteration ya no debe perderse en un console.warn únicamente.
const setTrainingError = async (detectionModelId, errorMessage) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',    sql.Int,         detectionModelId)
    .input('error', sql.VarChar(500), errorMessage ? String(errorMessage).slice(0, 500) : null)
    .query(`
      UPDATE ${TABLE}
      SET last_training_error = @error
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  return r.recordset[0] ?? null;
};

// Cableado 2026-08-03 — persiste `model_version`/`last_publish_name` tras una publicación
// exitosa en Custom Vision. Separado de `setActiveVersion()` (que ya hace el swap de
// is_active/status) porque esos dos campos son específicos de la spec v1.4 y no existían en
// el ciclo de versioning manual retirado (que versionaba insertando filas nuevas en vez de
// incrementar `model_version` en la misma fila — ver modelTrainingService.js para el porqué
// de mantener una sola fila por categoría en el flujo automático).
const markPublished = async (detectionModelId, { modelVersion, lastPublishName }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',          sql.Int,         detectionModelId)
    .input('version',     sql.Int,         modelVersion)
    .input('publishName', sql.VarChar(100), lastPublishName)
    .query(`
      UPDATE ${TABLE}
      SET model_version     = @version,
          last_publish_name = @publishName
      OUTPUT INSERTED.*
      WHERE detection_model_id = @id
    `);
  // Ver NOTA en markTrained (arriba) — separado del UPDATE crítico para que un fallo por
  // migración 009 faltante nunca bloquee esto: acá es más grave que en markTrained, porque el
  // caller (modelTrainingService.publishAndActivate) NO envuelve esta llamada en try/catch —
  // si el UPDATE original tiraba por columna inexistente, setActiveVersion() (el swap que
  // realmente marca PUBLISHED) nunca llegaba a ejecutarse.
  await clearTrainingErrorBestEffort(detectionModelId);
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
  // Cableado 2026-08-03 (flujo automático spec v1.4)
  markTrained,
  markPublished,
  // Cableado 2026-08-08 (fix del fallo silencioso de training/publicación)
  markTrainingFailed,
  setTrainingError,
};
