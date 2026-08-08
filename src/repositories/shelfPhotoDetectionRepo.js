// Repositorio para RETSC_EX_SHELFPHOTO_DETECTION (Pasos 4/5/6 de la guía "Fotos de
// Visita" v1.9, María Royo). Tabla nueva — ver migración 008_create_visit_photo_pipeline.sql.
//
// Distinto de RETSC_AI_TRAINING_ANNOTATIONS (annotationRepo.js): esa tabla es para el
// pipeline de ENTRENAMIENTO del modelo de detección (fotos globales, anotadas a mano por el
// equipo DTC); esta es para las detecciones de una foto de visita REAL en producción, ya
// contra un modelo publicado, con Sku_id/EAN resueltos (o no) por el paso de identificación.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_EX_SHELFPHOTO_DETECTION';

// ─── Escritura ────────────────────────────────────────────────────────────────

// Inserta una detección (una "cajita"). Sku_id/EAN/ocr_text quedan NULL — se llenan
// después con updateIdentification() (Paso 5).
const insert = async ({ photoId, detectionModelId, confidence, bboxLeft, bboxTop, bboxWidth, bboxHeight }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId',   sql.Int,   photoId)
    .input('modelId',   sql.Int,   detectionModelId ?? null)
    .input('confidence',sql.Float, confidence ?? null)
    .input('left',      sql.Float, bboxLeft)
    .input('top',       sql.Float, bboxTop)
    .input('width',     sql.Float, bboxWidth)
    .input('height',    sql.Float, bboxHeight)
    .query(`
      INSERT INTO ${TABLE}
        (Photo_id, detection_model_id, Confidence, Bbox_left, Bbox_top, Bbox_width, Bbox_height)
      OUTPUT INSERTED.*
      VALUES
        (@photoId, @modelId, @confidence, @left, @top, @width, @height)
    `);
  return r.recordset[0];
};

// Inserta todas las regiones que devolvió el modelo para una foto (Paso 4). No usa
// transacción explícita a propósito — mismo criterio que skuFeatureRepo.insertMetadata():
// un fallo a mitad de lote deja algunas cajitas guardadas y otras no, lo cual es preferible
// a perder TODAS las detecciones ya calculadas por un error en una sola fila.
// Devuelve el array de filas insertadas (con su Detection_id).
const bulkInsert = async (photoId, detectionModelId, regions) => {
  if (!regions || regions.length === 0) return [];
  const inserted = [];
  for (const region of regions) {
    inserted.push(await insert({
      photoId,
      detectionModelId,
      confidence: region.confidence,
      bboxLeft:   region.left,
      bboxTop:    region.top,
      bboxWidth:  region.width,
      bboxHeight: region.height,
    }));
  }
  return inserted;
};

// Paso 5 de la guía — UPDATE exacto de la sección 7.1: el EAN se saca del mismo sku_id en
// la misma sentencia (RETSC_OP_SKUS.EAN es UNIQUE y NOT NULL, según la guía), en vez de
// recibirlo como parámetro aparte. Si skuId es null (sin match), EAN queda NULL también
// (la subquery no encuentra ninguna fila) — ese es el caso "cajita detectada pero sin
// identificar", explícitamente válido según la guía.
// ocr_text se guarda SIEMPRE, haya o no match (ver guía sección 7.1) — es lo que permite
// la vista de "no identificados" del dashboard web (sección 8.4).
const updateIdentification = async (detectionId, { skuId, ocrText }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',     sql.Int,               detectionId)
    .input('skuId',  sql.Int,               skuId ?? null)
    .input('ocrText',sql.NVarChar(sql.MAX), ocrText ?? null)
    .query(`
      UPDATE ${TABLE}
      SET Sku_id = @skuId,
          EAN = (SELECT EAN FROM RETSC_OP_SKUS WHERE SKU_ID = @skuId),
          ocr_text = @ocrText
      OUTPUT INSERTED.*
      WHERE Detection_id = @id
    `);
  return r.recordset[0] ?? null;
};

// ─── Lectura ─────────────────────────────────────────────────────────────────

const findByPhotoId = async (photoId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId', sql.Int, photoId)
    .query(`SELECT * FROM ${TABLE} WHERE Photo_id = @photoId`);
  return r.recordset;
};

// Sección 8.1 de la guía — share de góndola por marca para una visita. Cruza contra
// RETSC_OP_ENTERPRISE_PRODUCT_SEG filtrando también por enterprise_id (la clasificación de
// marca puede variar según qué enterprise la esté viendo — nota explícita de la guía).
const shareDeGondolaByVisit = async (visitId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('visitId', sql.Int, visitId)
    .query(`
      SELECT seg.Brand,
             COUNT(*) AS conteo,
             CAST(COUNT(*) AS FLOAT) / SUM(COUNT(*)) OVER () AS share
      FROM ${TABLE} d
      JOIN RETSC_EX_SHELFPHOTO p ON p.Photo_id = d.Photo_id
      JOIN RETSC_OP_ENTERPRISE_PRODUCT_SEG seg
        ON seg.sku_id = d.Sku_id AND seg.enterprise_id = p.ENTERPRISE_ID
      WHERE p.visit_id = @visitId
        AND d.Sku_id IS NOT NULL
      GROUP BY seg.Brand
      ORDER BY conteo DESC
    `);
  return r.recordset;
};

// Cuenta cajitas detectadas en una visita que quedaron sin identificar (Sku_id NULL) —
// alimenta el campo "sin_identificar" de la respuesta del Paso 6 (sección 8.3 de la guía).
const countUnidentifiedByVisit = async (visitId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('visitId', sql.Int, visitId)
    .query(`
      SELECT COUNT(*) AS cnt
      FROM ${TABLE} d
      JOIN RETSC_EX_SHELFPHOTO p ON p.Photo_id = d.Photo_id
      WHERE p.visit_id = @visitId AND d.Sku_id IS NULL
    `);
  return r.recordset[0]?.cnt ?? 0;
};

// Todos los Sku_id ya detectados (no NULL) en una visita — usado por assortmentRepo para
// calcular los faltantes del surtido propio (sección 8.2), sin repetir el join aquí.
const listDetectedSkuIdsByVisit = async (visitId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('visitId', sql.Int, visitId)
    .query(`
      SELECT DISTINCT d.Sku_id
      FROM ${TABLE} d
      JOIN RETSC_EX_SHELFPHOTO p ON p.Photo_id = d.Photo_id
      WHERE p.visit_id = @visitId AND d.Sku_id IS NOT NULL
    `);
  return r.recordset.map(row => row.Sku_id);
};

// Sección 8.4 de la guía — "productos no identificados, posibles productos nuevos en
// góndola". Visibilidad pasiva para el dashboard web: no requiere que nadie la reporte.
const listUnidentifiedByEnterprise = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`
      SELECT d.Detection_id, d.ocr_text,
             p.URL_blob, d.Bbox_left, d.Bbox_top, d.Bbox_width, d.Bbox_height
      FROM ${TABLE} d
      JOIN RETSC_EX_SHELFPHOTO p ON p.Photo_id = d.Photo_id
      WHERE p.ENTERPRISE_ID = @enterpriseId
        AND d.Sku_id IS NULL
      ORDER BY p.photo_date DESC
    `);
  return r.recordset;
};

module.exports = {
  insert,
  bulkInsert,
  updateIdentification,
  findByPhotoId,
  shareDeGondolaByVisit,
  countUnidentifiedByVisit,
  listDetectedSkuIdsByVisit,
  listUnidentifiedByEnterprise,
};
