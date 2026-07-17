const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_PRODUCTS';

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE Product_id = @id`);
  return r.recordset[0] ?? null;
};

const findByGtinAndEnterprise = async (gtin, enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('gtin',         sql.VarChar(20), gtin)
    .input('enterpriseId', sql.Int,         enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE GTIN = @gtin AND Enterprise_id = @enterpriseId`);
  return r.recordset[0] ?? null;
};

// Arma la condición WHERE compartida por el SELECT paginado y el COUNT(*).
// Devuelve el texto del WHERE y aplica los .input() correspondientes sobre `req`.
// NOTA (B1/B5 QA, 2026-07-17): el link enterprise↔sku es RETSC_OP_ENTERPRISE_PRODUCT_SEG
// (alias seg) — RETSC_OP_ENTERPRISE_SKUS no existe en ningún ambiente.
// NOTA (fix carga SKU brand/categoría, ver docs/PROMPT-fix-carga-sku-brand-category.md):
// el filtro de "categoría" pasó a ser texto libre sobre seg.client_category (la
// categoría propia del cliente, tal como viene en su Excel de carga) en vez de
// sk.selected_category_id (el árbol oficial RETSC_OP_CATEGORIES, que es una sola
// categoría por batch de carga, no por fila del Excel — eso causaba que productos
// de una misma categoría real aparecieran con categorías distintas en la UI).
function buildFilters(req, enterpriseId, filters) {
  req.input('enterpriseId', sql.Int, enterpriseId);
  let whereExtra = '';

  if (filters.categoryId != null && filters.categoryId !== '') {
    req.input('categoryId', sql.NVarChar(100), filters.categoryId);
    whereExtra += ' AND seg.client_category = @categoryId';
  }

  if (filters.search) {
    req.input('search', sql.NVarChar(200), `%${filters.search}%`);
    whereExtra += ' AND (sk.EAN LIKE @search OR sk.Product_dsc LIKE @search)';
  }

  return whereExtra;
}

// Paginación server-side (OFFSET/FETCH) + total vía COUNT(*) — mismo WHERE en ambas.
const listByEnterprise = async (enterpriseId, filters = {}) => {
  const pool = await getPool();
  const page  = Math.max(1, Number(filters.page)  || 1);
  const limit = Math.max(1, Number(filters.limit) || 50);
  const offset = (page - 1) * limit;

  const countReq = pool.request();
  const whereExtraCount = buildFilters(countReq, enterpriseId, filters);
  const countResult = await countReq.query(`
    SELECT COUNT(DISTINCT sk.SKU_ID) AS total
    FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG seg
    JOIN RETSC_OP_SKUS sk
      ON sk.SKU_ID = seg.sku_id
    WHERE seg.enterprise_id = @enterpriseId
      AND seg.status = 'ACTIVE'
    ${whereExtraCount}
  `);
  const total = countResult.recordset[0]?.total ?? 0;

  const listReq = pool.request()
    .input('offset', sql.Int, offset)
    .input('limit',  sql.Int, limit);
  const whereExtraList = buildFilters(listReq, enterpriseId, filters);
  const r = await listReq.query(`
    SELECT DISTINCT
      sk.EAN,
      sk.SKU_ID,
      sk.image_url,
      sk.SKU_ID     AS product_id,
      sk.Product_dsc,
      sk.selected_category_id AS Category_id,
      seg.Brand,
      seg.Supplier,
      seg.client_category,
      seg.client_subcategory,
      seg.volume,
      seg.Relevant_feature,
      sk.status,
      cat.Category_dsc AS commercial_category_dsc
    FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG seg
    JOIN RETSC_OP_SKUS sk
      ON sk.SKU_ID = seg.sku_id
    LEFT JOIN RETSC_OP_CATEGORIES cat
      ON cat.Category_id = sk.selected_category_id
    WHERE seg.enterprise_id = @enterpriseId
      AND seg.status = 'ACTIVE'
    ${whereExtraList}
    ORDER BY sk.Product_dsc ASC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  `);
  return { rows: r.recordset, total };
};

// GET /api/products/categories — categorías propias del cliente (client_category,
// texto libre del Excel de carga) que tienen al menos un SKU cargado para la
// empresa actual. Antes agrupaba por el árbol RETSC_OP_CATEGORIES; se cambió
// porque ese árbol es una sola categoría por batch de carga, no refleja lo que
// el cliente puso realmente en cada fila de su Excel.
const listCategoriesWithProducts = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`
      SELECT DISTINCT seg.client_category
      FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG seg
      WHERE seg.enterprise_id = @enterpriseId
        AND seg.status = 'ACTIVE'
        AND seg.client_category IS NOT NULL
      ORDER BY seg.client_category ASC
    `);
  return r.recordset;
};

const insert = async (product) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId',    sql.Int,           product.Enterprise_id)
    .input('gtin',            sql.VarChar(20),   product.GTIN)
    .input('description',     sql.NVarChar(500), product.Description)
    .input('categoryName',    sql.NVarChar(200), product.Category_name ?? null)
    .input('subcategory',     sql.NVarChar(200), product.Subcategory ?? null)
    .input('segment',         sql.NVarChar(200), product.Segment ?? null)
    .input('brand',           sql.NVarChar(200), product.Brand ?? null)
    .input('primaryImageUrl', sql.NVarChar(sql.MAX), product.Primary_image_url ?? null)
    .input('status',          sql.Int,           product.Status ?? 1)
    .input('createdDate',     sql.VarChar(50),   product.Created_date ?? new Date().toISOString())
    .query(`
      INSERT INTO ${TABLE}
        (Enterprise_id, GTIN, Description, Category_name, Subcategory, Segment, Brand,
         Primary_image_url, Status, Created_date)
      OUTPUT INSERTED.*
      VALUES
        (@enterpriseId, @gtin, @description, @categoryName, @subcategory, @segment, @brand,
         @primaryImageUrl, @status, @createdDate)
    `);
  return r.recordset[0];
};

const insertMany = async (products) => {
  const inserted = [];
  for (const p of products) {
    inserted.push(await insert(p));
  }
  return inserted;
};

const update = async (id, partial) => {
  const pool = await getPool();
  const req = pool.request().input('id', sql.Int, id);
  const set = [];

  if (partial.Enterprise_id !== undefined)    { req.input('eid',   sql.Int,               partial.Enterprise_id);    set.push('Enterprise_id = @eid'); }
  if (partial.GTIN !== undefined)             { req.input('gtin',  sql.VarChar(20),        partial.GTIN);             set.push('GTIN = @gtin'); }
  if (partial.Description !== undefined)      { req.input('desc',  sql.NVarChar(500),      partial.Description);      set.push('Description = @desc'); }
  if (partial.Category_name !== undefined)    { req.input('cat',   sql.NVarChar(200),      partial.Category_name);    set.push('Category_name = @cat'); }
  if (partial.Subcategory !== undefined)      { req.input('sub',   sql.NVarChar(200),      partial.Subcategory);      set.push('Subcategory = @sub'); }
  if (partial.Segment !== undefined)          { req.input('seg',   sql.NVarChar(200),      partial.Segment);          set.push('Segment = @seg'); }
  if (partial.Brand !== undefined)            { req.input('brand', sql.NVarChar(200),      partial.Brand);            set.push('Brand = @brand'); }
  if (partial.Primary_image_url !== undefined){ req.input('img',   sql.NVarChar(sql.MAX),  partial.Primary_image_url);set.push('Primary_image_url = @img'); }
  if (partial.Status !== undefined)           { req.input('stat',  sql.Int,                partial.Status);           set.push('Status = @stat'); }

  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE ${TABLE} SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE Product_id = @id
  `);
  return r.recordset[0] ?? null;
};

module.exports = { findById, findByGtinAndEnterprise, listByEnterprise, listCategoriesWithProducts, insert, insertMany, update };
