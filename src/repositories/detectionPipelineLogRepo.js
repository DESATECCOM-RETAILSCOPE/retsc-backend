// RETSC_LOG_DETECTION_PIPELINE (migración 012) — historial persistente de cada corrida del
// pipeline de detección, para poder diagnosticar después del hecho por qué una foto quedó
// sin detecciones (ver detectionPipelineService.js).
//
// discarded_by_shape (migración 014) queda en la tabla como histórico pero dejó de
// escribirse 2026-09-28 (el filtro de forma se desactivó — ver customVisionPredictService.js).
// discarded_as_duplicate (migración 015) lo reemplaza: cuenta cajitas descartadas por
// duplicateDetectionFilter.js DESPUÉS de la identificación (Paso 5), no por forma.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_LOG_DETECTION_PIPELINE';

const insert = async ({
  photoId, categoryId, status, reasonCode, rawPredictions, detectionsSaved,
  thresholdApplied, attempts, errorMessage, durationMs, discardedAsDuplicate,
}) => {
  const pool = await getPool();
  await pool.request()
    .input('photoId',          sql.Int,           photoId)
    .input('categoryId',       sql.Int,           categoryId)
    .input('status',           sql.VarChar(20),   status)
    .input('reasonCode',       sql.VarChar(30),   reasonCode ?? null)
    .input('rawPredictions',   sql.Int,           rawPredictions ?? null)
    .input('detectionsSaved',  sql.Int,           detectionsSaved ?? 0)
    .input('thresholdApplied', sql.Decimal(5, 2), thresholdApplied ?? null)
    .input('attempts',         sql.Int,           attempts ?? 1)
    .input('errorMessage',     sql.NVarChar(sql.MAX), errorMessage ?? null)
    .input('durationMs',       sql.Int,           durationMs ?? null)
    .input('discardedAsDuplicate', sql.Int,       discardedAsDuplicate ?? null)
    .query(`
      INSERT INTO ${TABLE}
        (photo_id, category_id, status, reason_code, raw_predictions, detections_saved,
         threshold_applied, attempts, error_message, duration_ms, discarded_as_duplicate)
      VALUES
        (@photoId, @categoryId, @status, @reasonCode, @rawPredictions, @detectionsSaved,
         @thresholdApplied, @attempts, @errorMessage, @durationMs, @discardedAsDuplicate)
    `);
};

module.exports = { insert };
