// Dashboard web (Parte B): catálogo de productos y cobertura de fotos.
// Lo usan el Resumen (KPIs) y la pantalla 3, Catálogo & Fotos.
//
// El catálogo es GLOBAL a propósito (la pantalla Catálogo dice "catálogo maestro
// global"): los totales cuentan todos los SKUs activos. La empresa solo define cuáles
// son "propios": los que alguna vez estuvieron en su surtido (anexo, query 5).
//
// Ajustes sobre el anexo, verificados en QA:
//   · Estado activo: 'ACTIVE' (B4, 26-oct-2026). El anexo usaba 'ACTIVO', que
//     devuelve 0 filas.
//   · Categoría: detection_category_id (categoría del árbol DTC, RETSC_OP_CATEGORIES).
//     El anexo usaba selected_category_id, que apunta a RETSC_OP_ENTERPRISE_CATEGORIES
//     (la categoría de la empresa que cargó el SKU): con el filtro category=2 daba 0
//     productos aunque hay 201 (verificación del 28-oct-2026). Es la misma columna que
//     usa productRepo para el filtro de categoría oficial.

const { getPool, sql } = require('../config/db');

const SKUS       = 'RETSC_OP_SKUS';
const ASSORTMENT = 'RETSC_OP_ASSORTMENT';
const CATEGORIES = 'RETSC_OP_CATEGORIES';
const UPLOAD_LOG = 'RETSC_LOG_IMAGE_UPLOAD';
const TRAINING   = 'RETSC_AI_TRAINING_PHOTOS';
const SHELFPHOTO = 'RETSC_EX_SHELFPHOTO';
const ACTIVO     = 'ACTIVE';

async function request(f) {
  const pool = await getPool();
  return pool.request()
    .input('enterpriseId', sql.Int,         f.enterpriseId)
    .input('category',     sql.Int,         f.category)
    .input('activo',       sql.VarChar(20), ACTIVO);
}

// Productos registrados, propios y competencia (anexo 5).
async function productos(f) {
  const r = await (await request(f)).query(`
    ;WITH propios AS (
      SELECT DISTINCT sku_id FROM ${ASSORTMENT} WHERE enterprise_id = @enterpriseId
    )
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN p.sku_id IS NOT NULL THEN 1 ELSE 0 END) AS propios,
           SUM(CASE WHEN p.sku_id IS NULL     THEN 1 ELSE 0 END) AS competencia
    FROM ${SKUS} sku
    LEFT JOIN propios p ON p.sku_id = sku.SKU_ID
    WHERE sku.status = @activo
      AND (@category IS NULL OR sku.detection_category_id = @category);
  `);
  const row = r.recordset[0] ?? {};
  return {
    total:       Number(row.total) || 0,
    propios:     Number(row.propios) || 0,
    competencia: Number(row.competencia) || 0,
  };
}

// Cobertura de foto del catálogo vigente (anexo 6B).
async function coberturaFotos(f) {
  const r = await (await request(f)).query(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN NULLIF(LTRIM(RTRIM(sku.image_url)), '') IS NOT NULL THEN 1 ELSE 0 END) AS con_foto
    FROM ${SKUS} sku
    WHERE sku.status = @activo
      AND (@category IS NULL OR sku.detection_category_id = @category);
  `);
  const row = r.recordset[0] ?? {};
  const total = Number(row.total) || 0;
  const conFoto = Number(row.con_foto) || 0;
  return { total, con_foto: conFoto, sin_foto: total - conFoto };
}

// ── Pantalla 3, Catálogo & Fotos ───────────────────────────────────────────

// Productos por categoría: propios y competencia (anexo 5, por categoría).
async function productosPorCategoria(f) {
  const r = await (await request(f)).query(`
    ;WITH propios AS (
      SELECT DISTINCT sku_id FROM ${ASSORTMENT} WHERE enterprise_id = @enterpriseId
    )
    SELECT sku.detection_category_id AS category_id,
           cat.Category_dsc AS categoria,
           COUNT(*) AS total,
           SUM(CASE WHEN p.sku_id IS NOT NULL THEN 1 ELSE 0 END) AS propios,
           SUM(CASE WHEN p.sku_id IS NULL     THEN 1 ELSE 0 END) AS competencia
    FROM ${SKUS} sku
    LEFT JOIN propios p ON p.sku_id = sku.SKU_ID
    LEFT JOIN ${CATEGORIES} cat ON cat.Category_id = sku.detection_category_id
    WHERE sku.status = @activo
      AND (@category IS NULL OR sku.detection_category_id = @category)
    GROUP BY sku.detection_category_id, cat.Category_dsc
    ORDER BY total DESC, categoria;
  `);
  return r.recordset;
}

// Cobertura de foto por categoría (anexo 6B, por categoría).
async function coberturaPorCategoria(f) {
  const r = await (await request(f)).query(`
    SELECT sku.detection_category_id AS category_id,
           cat.Category_dsc AS categoria,
           COUNT(*) AS total,
           SUM(CASE WHEN NULLIF(LTRIM(RTRIM(sku.image_url)), '') IS NOT NULL THEN 1 ELSE 0 END) AS con_foto
    FROM ${SKUS} sku
    LEFT JOIN ${CATEGORIES} cat ON cat.Category_id = sku.detection_category_id
    WHERE sku.status = @activo
      AND (@category IS NULL OR sku.detection_category_id = @category)
    GROUP BY sku.detection_category_id, cat.Category_dsc
    ORDER BY categoria;
  `);
  return r.recordset;
}

// Detalle de soporte de la carga de fotos (anexo 6A): estados del log de carga de la
// empresa. Con categoría, se filtra por la categoría del SKU asociado; las fotos
// huérfanas (sin SKU) solo aparecen sin filtro de categoría.
async function detalleCarga(f) {
  const r = await (await request(f)).query(`
    SELECT l.process_status, l.ocr_status, l.embeddings_status, COUNT(*) AS cantidad
    FROM ${UPLOAD_LOG} l
    LEFT JOIN ${SKUS} sku ON sku.SKU_ID = l.sku_id
    WHERE l.enterprise_id = @enterpriseId
      AND (@category IS NULL OR sku.detection_category_id = @category)
    GROUP BY l.process_status, l.ocr_status, l.embeddings_status
    ORDER BY cantidad DESC;
  `);
  return r.recordset;
}

// Fotos de góndola por categoría (anexo 7): entrenamiento y visitas, lado a lado y
// nunca sumadas (regla de B2). Entrenamiento: subidas por la empresa (total y
// aprobadas). Visitas: fotos tomadas en campo por la empresa.
async function fotosGondola(f) {
  const r = await (await request(f)).query(`
    ;WITH ent AS (
      SELECT category_id,
             COUNT(*) AS fotos_entrenamiento,
             SUM(CASE WHEN photo_status = 'APROBADA' THEN 1 ELSE 0 END) AS entrenamiento_aprobadas
      FROM ${TRAINING}
      WHERE uploaded_by_enterprise_id = @enterpriseId
        AND (@category IS NULL OR category_id = @category)
      GROUP BY category_id
    ),
    vis AS (
      SELECT CATEGORY_ID AS category_id, COUNT(*) AS fotos_visita
      FROM ${SHELFPHOTO}
      WHERE Enterprise_id = @enterpriseId
        AND (@category IS NULL OR CATEGORY_ID = @category)
      GROUP BY CATEGORY_ID
    )
    SELECT COALESCE(ent.category_id, vis.category_id) AS category_id,
           cat.Category_dsc AS categoria,
           ISNULL(ent.fotos_entrenamiento, 0)     AS fotos_entrenamiento,
           ISNULL(ent.entrenamiento_aprobadas, 0) AS entrenamiento_aprobadas,
           ISNULL(vis.fotos_visita, 0)            AS fotos_visita
    FROM ent
    FULL OUTER JOIN vis ON vis.category_id = ent.category_id
    LEFT JOIN ${CATEGORIES} cat ON cat.Category_id = COALESCE(ent.category_id, vis.category_id)
    ORDER BY categoria;
  `);
  return r.recordset;
}

module.exports = {
  productos,
  coberturaFotos,
  productosPorCategoria,
  coberturaPorCategoria,
  detalleCarga,
  fotosGondola,
  ACTIVO,
};
