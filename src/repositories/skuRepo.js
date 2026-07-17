/**
 * Repositorio SKU — catálogo global y segmentación enterprise.
 *
 * Esquema real en BD (verificado con INFORMATION_SCHEMA + sys.foreign_keys, 2026-07-17;
 * RETSC_OP_PRODUCTS y RETSC_OP_ENTERPRISE_SKUS NO EXISTEN — ver docs/TODO-prioridad-3.md /
 * Issue B1-B5 de QA para el historial de esta corrección):
 *   RETSC_OP_SKUS                    (SKU global)
 *   RETSC_OP_ENTERPRISE_PRODUCT_SEG  (segmentación por enterprise — antes se escribía
 *                                      contra una tabla RETSC_OP_ENTERPRISE_SKUS que
 *                                      nunca existió en ningún ambiente)
 *
 * Columnas reales de RETSC_OP_SKUS:
 *   SKU_ID, EAN, image_url, creation_date, image_status,
 *   Product_dsc, status, selected_category_id, detection_category_id
 *
 * Columnas reales de RETSC_OP_ENTERPRISE_PRODUCT_SEG:
 *   seg_id (PK identity), enterprise_id (FK→RETSC_OP_ENTERPRISE), sku_id (FK→RETSC_OP_SKUS),
 *   status, created_at, updated_at, client_category, client_subcategory, Brand, Supplier,
 *   normalized_name, Relevant_feature, volume.
 *   Constraint único (enterprise_id, sku_id) — UQ_RETSC_ENTERPRISE_SKU_SEG.
 *   NOTA: esta tabla NO tiene selected_category_id/detection_category_id — la
 *   categorización de un SKU vive solo en RETSC_OP_SKUS (a nivel global, no por-empresa).
 *
 * Mapeo de categorías en RETSC_OP_SKUS:
 *   selected_category_id  → enterprise_category_id (PK de RETSC_OP_ENTERPRISE_CATEGORIES)
 *   detection_category_id → resolved_category_id (Category_id de RETSC_OP_CATEGORIES, la smart)
 */

const { getPool, sql } = require("../config/db");

// ── RETSC_OP_SKUS ──────────────────────────────────────────────────────────

const findSkuByEan = async (ean) => {
  const pool = await getPool();
  const r = await pool.request().input("ean", sql.VarChar(18), ean).query(`
      SELECT SKU_ID, EAN, Product_dsc, status,
             selected_category_id, detection_category_id,
             image_url, image_status
      FROM RETSC_OP_SKUS
      WHERE EAN = @ean
    `);
  return r.recordset[0] ?? null;
};

const insertSku = async (data) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("ean", sql.VarChar(18), data.ean)
    .input("productDsc", sql.VarChar(100), data.productDsc ?? null)
    .input("selectedCat", sql.Int, data.selectedCategoryId ?? null)
    .input("detectionCat", sql.Int, data.detectionCategoryId ?? null)
    .input("status", sql.VarChar(20), "ACTIVE").query(`
      INSERT INTO RETSC_OP_SKUS
        (EAN, Product_dsc, selected_category_id, detection_category_id, status, creation_date)
      OUTPUT INSERTED.*
      VALUES
        (@ean, @productDsc, @selectedCat, @detectionCat, @status, GETDATE())
    `);
  return r.recordset[0];
};

const updateSku = async (skuId, partial) => {
  const pool = await getPool();
  const req = pool.request().input("skuId", sql.Int, skuId);
  const set = [];

  if (partial.productDsc !== undefined) {
    req.input("dsc", sql.VarChar(100), partial.productDsc ?? null);
    set.push("Product_dsc = @dsc");
  }
  if (partial.selectedCategoryId !== undefined) {
    req.input("selectedCat", sql.Int, partial.selectedCategoryId ?? null);
    set.push("selected_category_id = @selectedCat");
  }
  if (partial.detectionCategoryId !== undefined) {
    req.input("detectionCat", sql.Int, partial.detectionCategoryId ?? null);
    set.push("detection_category_id = @detectionCat");
  }
  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE RETSC_OP_SKUS SET ${set.join(", ")}
    OUTPUT INSERTED.*
    WHERE SKU_ID = @skuId
  `);
  return r.recordset[0] ?? null;
};

// ── RETSC_OP_ENTERPRISE_PRODUCT_SEG ─────────────────────────────────────────
// Link enterprise↔sku real (antes apuntaba a RETSC_OP_ENTERPRISE_SKUS, que no existe).
// No recibe categoría: esta tabla no tiene esas columnas — la categorización del
// SKU (selected_category_id/detection_category_id) ya se graba en RETSC_OP_SKUS
// vía insertSku/updateSku, a nivel global, no por-empresa.

const findEnterpriseSku = async (enterpriseId, skuId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("enterpriseId", sql.Int, enterpriseId)
    .input("skuId", sql.Int, skuId).query(`
      SELECT * FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG
      WHERE enterprise_id = @enterpriseId AND sku_id = @skuId
    `);
  return r.recordset[0] ?? null;
};

const insertEnterpriseSku = async (data) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("enterpriseId", sql.Int, data.enterpriseId)
    .input("skuId", sql.Int, data.skuId)
    .input("status", sql.VarChar(20), "ACTIVE").query(`
      INSERT INTO RETSC_OP_ENTERPRISE_PRODUCT_SEG
        (enterprise_id, sku_id, status, created_at)
      OUTPUT INSERTED.*
      VALUES (@enterpriseId, @skuId, @status, GETDATE())
    `);
  return r.recordset[0];
};

// ── RETSC_LOG_SKU_UPLOAD ───────────────────────────────────────────────────

const logSkuRow = async (data) => {
  const pool = await getPool();
  await pool
    .request()
    .input("enterpriseId", sql.Int, data.enterpriseId)
    .input("batchId", sql.UniqueIdentifier, data.batchId)
    .input("rowNumber", sql.Int, data.rowNumber)
    .input("ean", sql.VarChar(20), data.ean)
    .input("skuDescription", sql.VarChar(500), data.skuDescription ?? null)
    .input("selectedCatId", sql.Int, data.selectedCategoryId ?? null)
    .input("detectionCatId", sql.Int, data.detectionCategoryId ?? null)
    .input("processStatus", sql.VarChar(50), data.processStatus)
    .input("errorCode", sql.VarChar(100), data.errorCode ?? null)
    .input("errorMessage", sql.VarChar(1000), data.errorMessage ?? null).query(`
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
