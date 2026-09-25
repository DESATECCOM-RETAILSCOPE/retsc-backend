// RETSC_LOG_SKU_IDENTIFICATION (migración 013) — historial persistente del paso de OCR +
// búsqueda de SKU, hermano de detectionPipelineLogRepo.js (que solo cubre Custom Vision).

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_LOG_SKU_IDENTIFICATION';

const insert = async ({ photoId, totalBoxes, matchedCount, errorMessage, durationMs }) => {
  const pool = await getPool();
  await pool.request()
    .input('photoId',      sql.Int,               photoId)
    .input('totalBoxes',   sql.Int,               totalBoxes)
    .input('matchedCount', sql.Int,               matchedCount ?? 0)
    .input('errorMessage', sql.NVarChar(sql.MAX),  errorMessage ?? null)
    .input('durationMs',   sql.Int,               durationMs ?? null)
    .query(`
      INSERT INTO ${TABLE} (photo_id, total_boxes, matched_count, error_message, duration_ms)
      VALUES (@photoId, @totalBoxes, @matchedCount, @errorMessage, @durationMs)
    `);
};

module.exports = { insert };
