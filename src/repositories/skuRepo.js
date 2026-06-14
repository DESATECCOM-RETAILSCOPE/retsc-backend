/**
 * Repositorio SKU — tablas del catálogo global y segmentación enterprise.
 *
 * Relación real en BD:
 *   RETSC_OP_PRODUCTS  (producto lógico global, sin Enterprise_id)
 *       ↑ product_id FK
 *   RETSC_OP_SKUS      (código EAN físico, 1 producto puede tener varios SKUs)
 *       ↑ sku_id FK
 *   RETSC_OP_ENTERPRISE_SKUS  (segmentación por enterprise)
 *
 * Todas las tablas ya existen en Azure SQL — no requieren CREATE.
 */

const { getPool, sql } = require('../config/db');

// ── RETSC_OP_PRODUCTS ──────────────────────────────────────────────────────
// Producto lógico global (sin Enterprise_id, sin GTIN directo)

// Busca por product_key (= EAN) para recuperación ante fallos parciales
const findProductByKey = async (productKey) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('key', sql.VarChar(100), productKey)
    .query('SELECT * FROM RETSC_OP_PRODUCTS WHERE product_key = @key');
  return r.recordset[0] ?? null;
};

const insertProduct = async (data) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('productDsc',        sql.VarChar(100), data.productDsc)
    .input('categoryId',        sql.Int,          data.categoryId ?? null)
    .input('productKey',        sql.VarChar(100), data.productKey)
    .input('brand',             sql.VarChar(200), data.brand             ?? null)
    .input('clientCategory',    sql.VarChar(200), data.clientCategory    ?? null)
    .input('clientSubcategory', sql.VarChar(200), data.clientSubcategory ?? null)
    .input('supplier',          sql.VarChar(200), data.supplier          ?? null)
    .input('status',            sql.VarChar(20),  'active')
    .query(`
      INSERT INTO RETSC_OP_PRODUCTS
        (Product_dsc, Category_id, product_key, Brand,
         client_category, client_subcategory, Supplier, status, creationdate)
      OUTPUT INSERTED.*
      VALUES
        (@productDsc, @categoryId, @productKey, @brand,
         @clientCategory, @clientSubcategory, @supplier, @status, GETDATE())
    `);
  return r.recordset[0];
};

const updateProduct = async (productId, partial) => {
  const pool = await getPool();
  const req  = pool.request().input('productId', sql.Int, productId);
  const set  = [];

  if (partial.productDsc !== undefined) {
    req.input('dsc',             sql.VarChar(100), partial.productDsc);
    set.push('Product_dsc = @dsc');
  }
  if (partial.brand !== undefined) {
    req.input('brand',           sql.VarChar(200), partial.brand             ?? null);
    set.push('Brand = @brand');
  }
  if (partial.clientCategory !== undefined) {
    req.input('clientCategory',  sql.VarChar(200), partial.clientCategory    ?? null);
    set.push('client_category = @clientCategory');
  }
  if (partial.clientSubcategory !== undefined) {
    req.input('clientSubcategory', sql.VarChar(200), partial.clientSubcategory ?? null);
    set.push('client_subcategory = @clientSubcategory');
  }
  if (partial.supplier !== undefined) {
    req.input('supplier',        sql.VarChar(200), partial.supplier          ?? null);
    set.push('Supplier = @supplier');
  }
  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE RETSC_OP_PRODUCTS SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE product_id = @productId
  `);
  return r.recordset[0] ?? null;
};

// ── RETSC_OP_SKUS ──────────────────────────────────────────────────────────
// Código EAN físico. FK NOT NULL → RETSC_OP_PRODUCTS.product_id

const findSkuByEan = async (ean) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('ean', sql.VarChar(18), ean)
    .query(`
      SELECT s.SKU_ID, s.EAN, s.product_id,
             p.Product_dsc, p.Category_id, p.Brand,
             p.client_category, p.client_subcategory, p.Supplier
      FROM RETSC_OP_SKUS s
      LEFT JOIN RETSC_OP_PRODUCTS p ON p.product_id = s.product_id
      WHERE s.EAN = @ean
    `);
  return r.recordset[0] ?? null;
};

const insertSku = async (data) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('ean',       sql.VarChar(18), data.ean)
    .input('productId', sql.Int,         data.productId)
    .query(`
      INSERT INTO RETSC_OP_SKUS (EAN, product_id, creation_date)
      OUTPUT INSERTED.*
      VALUES (@ean, @productId, GETDATE())
    `);
  return r.recordset[0];
};

// ── RETSC_OP_ENTERPRISE_SKUS ───────────────────────────────────────────────
// selected_category_id  → Category_id de RETSC_OP_CATEGORIES (FK_ENTSKU_SELECTEDCAT)
// detection_category_id → Category_id de RETSC_OP_CATEGORIES para AI (resolved o selected)

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
    .input('enterpriseId',    sql.Int, data.enterpriseId)
    .input('skuId',           sql.Int, data.skuId)
    .input('selectedCatId',   sql.Int, data.selectedCategoryId)   // Category_id de RETSC_OP_CATEGORIES
    .input('detectionCatId',  sql.Int, data.detectionCategoryId)  // Category_id de RETSC_OP_CATEGORIES (para AI)
    .query(`
      INSERT INTO RETSC_OP_ENTERPRISE_SKUS
        (enterprise_id, sku_id, selected_category_id, detection_category_id, created_at)
      OUTPUT INSERTED.*
      VALUES (@enterpriseId, @skuId, @selectedCatId, @detectionCatId, GETDATE())
    `);
  return r.recordset[0];
};

// ── RETSC_LOG_SKU_UPLOAD ───────────────────────────────────────────────────
// Registro de auditoría por fila procesada

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
  findProductByKey,
  insertProduct,
  updateProduct,
  findSkuByEan,
  insertSku,
  findEnterpriseSku,
  insertEnterpriseSku,
  logSkuRow,
};
