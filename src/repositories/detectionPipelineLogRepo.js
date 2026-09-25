// RETSC_LOG_DETECTION_PIPELINE (migración 012) — historial persistente de cada corrida del
// pipeline de detección, para poder diagnosticar después del hecho por qué una foto quedó
// sin detecciones (ver detectionPipelineService.js).

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_LOG_DETECTION_PIPELINE';

const insert = async ({
  photoId, categoryId, status, reasonCode, rawPredictions, detectionsSaved,
  thresholdApplied, attempts, errorMessage, durationMs,
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
    .query(`
      INSERT INTO ${TABLE}
        (photo_id, category_id, status, reason_code, raw_predictions, detections_saved,
         threshold_applied, attempts, error_message, duration_ms)
      VALUES
        (@photoId, @categoryId, @status, @reasonCode, @rawPredictions, @detectionsSaved,
         @thresholdApplied, @attempts, @errorMessage, @durationMs)
    `);
};

module.exports = { insert };
