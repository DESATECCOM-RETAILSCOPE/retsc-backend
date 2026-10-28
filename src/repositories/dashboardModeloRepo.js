// Dashboard web (Parte B): modelo de Custom Vision y lectura OCR. Solo para DTC.
// Lo usan el Resumen (KPIs de precisión y lectura OCR) y la pantalla 4, Modelo IA & OCR.
//
// Modelo (anexo 8): "solo la última iteración" (regla de B2). Por categoría se toma la
// versión entrenada más recientemente (mayor trained_at), y se muestran juntos
// trained_at y last_publish_name, porque lo último entrenado no siempre es lo que
// corre hoy para el cliente (decisión de María, 20-sep-2026). Las métricas se guardan
// entre 0 y 1 (aiModelRepo; el mínimo recomendado es 0.80).
//
// OCR nivel 1 (anexo 9): métricas proxy sobre las detecciones de las fotos de visita
// de la empresa. Fechas con created_at >= @desde AND < @hastaExclusive (no BETWEEN).
// "Texto leído" excluye las cadenas vacías: el pipeline guarda ocr_text siempre,
// aunque el OCR no lea nada (shelfPhotoDetectionRepo). El anexo contaba
// ocr_text IS NOT NULL, y en QA eso daba 100 % (131 de 429 detecciones vacías).

const { getPool, sql } = require('../config/db');

const MODELS     = 'RETSC_AI_DETECTION_MODELS';
const CATEGORIES = 'RETSC_OP_CATEGORIES';
const DETECTION  = 'RETSC_EX_SHELFPHOTO_DETECTION';
const PHOTO      = 'RETSC_EX_SHELFPHOTO';

// Última iteración por categoría. category opcional (null = todas).
async function ultimaIteracion(category) {
  const pool = await getPool();
  const r = await pool.request()
    .input('category', sql.Int, category ?? null)
    .query(`
      ;WITH m AS (
        SELECT x.*,
               ROW_NUMBER() OVER (
                 PARTITION BY x.category_id
                 ORDER BY CASE WHEN x.trained_at IS NULL THEN 1 ELSE 0 END,
                          x.trained_at DESC, x.detection_model_id DESC
               ) AS rn
        FROM ${MODELS} x
        WHERE (@category IS NULL OR x.category_id = @category)
      )
      SELECT m.category_id,
             cat.Category_dsc AS categoria,
             m.model_name,
             m.model_version,
             m.status,
             m.is_active,
             m.precision_score,
             m.recall_score,
             m.mean_ap,
             m.confidence_threshold,
             m.trained_at,
             m.last_publish_name
      FROM m
      LEFT JOIN ${CATEGORIES} cat ON cat.Category_id = m.category_id
      WHERE m.rn = 1
      ORDER BY categoria, m.category_id;
    `);
  return r.recordset;
}

// Tasa de lectura OCR, nivel 1 (anexo 9).
async function lecturaOcr(f) {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId',   sql.Int,  f.enterpriseId)
    .input('category',       sql.Int,  f.category)
    .input('desde',          sql.Date, f.desde)
    .input('hastaExclusive', sql.Date, f.hastaExclusive)
    .query(`
      SELECT COUNT(*) AS total_detecciones,
             SUM(CASE WHEN NULLIF(LTRIM(RTRIM(d.ocr_text)), '') IS NOT NULL THEN 1 ELSE 0 END) AS con_texto_leido,
             SUM(CASE WHEN NULLIF(LTRIM(RTRIM(d.ocr_text)), '') IS NOT NULL AND d.Sku_id IS NOT NULL THEN 1 ELSE 0 END) AS texto_leido_con_match
      FROM ${DETECTION} d
      INNER JOIN ${PHOTO} p ON p.Photo_id = d.Photo_id
      WHERE p.Enterprise_id = @enterpriseId
        AND (@category IS NULL OR p.CATEGORY_ID = @category)
        AND d.created_at >= @desde
        AND d.created_at <  @hastaExclusive;
    `);
  const row = r.recordset[0] ?? {};
  return {
    total_detecciones:     Number(row.total_detecciones) || 0,
    con_texto_leido:       Number(row.con_texto_leido) || 0,
    texto_leido_con_match: Number(row.texto_leido_con_match) || 0,
  };
}

module.exports = { ultimaIteracion, lecturaOcr };
