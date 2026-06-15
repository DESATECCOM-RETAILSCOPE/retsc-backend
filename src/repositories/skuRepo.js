/**
 * Repositorio SKU — tablas del catálogo global y segmentación enterprise.
 *
 * Esquema real en BD (RETSC_OP_PRODUCTS no existe):
 *   RETSC_OP_SKUS               (SKU global: EAN, Product_dsc, Category_id, status)
 *       ↑ sku_id FK
 *   RETSC_OP_ENTERPRISE_SKUS    (segmentación por enterprise)
 *
 * Columnas de RETSC_OP_SKUS: SKU_ID, EAN, Presentation_type, has_visual_variant,
 *   image_url, creation_date, image_status, Product_dsc, Category_id, status
 */

const { getPool, sql } = require('../config/db');

// ── RETSC_OP_SKUS ──────────────────────────────────────────────────────────

const findSkuByEan = async (ean) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('ean', sql.VarChar(18), ean)
    .query(`
      SELECT SKU_ID, EAN, Product_dsc, Category_id, status,
             has_visual_variant, image_url
      FROM RETSC_OP_SKUS
      WHERE EAN = @ean
    `);
  return r.recordset[0] ?? null;
};

const insertSku = async (data) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('ean',        sql.VarChar(18),  data.ean)
    .input('productDsc', sql.VarChar(500), data.productDsc ?? null)
    .input('categoryId', sql.Int,          data.categoryId ?? null)
    .input('status',     sql.VarChar(20),  'active')
    .query(`
      INSERT INTO RETSC_OP_SKUS (EAN, Product_dsc, Category_id, status, creation_date)
      OUTPUT INSERTED.*
      VALUES (@ean, @productDsc, @categoryId, @status, GETDATE())
    `);
  return r.recordset[0];
};

const updateSku = async (skuId, partial) => {
  const pool = await getPool();
  const req = pool.request().input('skuId', sql.Int, skuId);
  const set = [];

  if (partial.productDsc !== undefined) {
    req.input('dsc', sql.VarChar(500), partial.productDsc ?? null);
    set.push('Product_dsc = @dsc');
  }
  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE RETSC_OP_SKUS SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE SKU_ID = @skuId
  `);
  return r.recordset[0] ?? null;
};

// ── RETSC_OP_ENTERPRISE_SKUS ───────────────────────────────────────────────
// selected_category_id  → Category_id de RETSC_OP_CATEGORIES
// detection_category_id → Category_id de RETSC_OP_CATEGORIES para AI

const findEnterpriseSku = async (enterpriseId, skuId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .input('skuId',        sql.Int, skuId)
    .query(`
      SELECT * FROM RETSC_OP_ENTERPRISE_SKUS
      WHERE enterprise_id = @enterpriseId AND sku_id = @skuId
    `);
  return r.recordset[0] ?? null;
};

const insertEnterpriseSku = async (data) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId',   sql.Int, data.enterpriseId)
    .input('skuId',          sql.Int, data.skuId)
    .input('selectedCatId',  sql.Int, data.selectedCategoryId)   // FK→RETSC_OP_CATEGORIES.Category_id
    .input('detectionCatId', sql.Int, data.detectionCategoryId)
    .query(`
      INSERT INTO RETSC_OP_ENTERPRISE_SKUS
        (enterprise_id, sku_id, selected_category_id, detection_category_id, created_at)
      OUTPUT INSERTED.*
      VALUES (@enterpriseId, @skuId, @selectedCatId, @detectionCatId, GETDATE())
    `);
  return r.recordset[0];
};

// ── RETSC_LOG_SKU_UPLOAD ───────────────────────────────────────────────────

const logSkuRow = async (data) => {
  const pool = await getPool();
  await pool.request()
    .input('enterpriseId',   sql.Int,              data.enterpriseId)
    .input('batchId',        sql.UniqueIdentifier, data.batchId)
    .input('rowNumber',      sql.Int,              data.rowNumber)
    .input('ean',            sql.VarChar(20),      data.ean)
    .input('skuDescription', sql.VarChar(500),     data.skuDescription ?? null)
    .input('selectedCatId',  sql.Int,              data.selectedCategoryId ?? null)
    .input('detectionCatId', sql.Int,              data.detectionCategoryId ?? null)
    .input('processStatus',  sql.VarChar(50),      data.processStatus)
    .input('errorCode',      sql.VarChar(100),     data.errorCode ?? null)
    .input('errorMessage',   sql.VarChar(1000),    data.errorMessage ?? null)
    .query(`
      INSERT INTO RETSC_LOG_SKU_UPLOAD
        (enterprise_id, upload_batch_id, row_number, ean, sku_description,
         selected_category_id, detection_category_id, process_status,
         error_code, error_message, created_at)
      VALUES
        (@enterpriseId, @batchId, @rowNumber, @ean, @skuDescription,
         @selectedCatId, @detectionCatId, @processStatus,
         @errorCode, @errorMessage, GETDATE())
    `);
};

module.exports = {
  findSkuByEan,
  insertSku,
  updateSku,
  findEnterpriseSku,
  insertEnterpriseSku,
  logSkuRow,
};
