const { getPool, sql } = require('../config/db');

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

module.exports = { listByEnterprise, listCategoriesWithProducts };
