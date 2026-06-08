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

const listByEnterprise = async (enterpriseId, filters = {}) => {
  const pool = await getPool();
  const req = pool.request().input('enterpriseId', sql.Int, enterpriseId);

  let whereExtra = '';

  if (filters.categoryId != null) {
    req.input('categoryId', sql.Int, filters.categoryId);
    whereExtra += ' AND es.selected_category_id = @categoryId';
  }

  if (filters.search) {
    req.input('search', sql.NVarChar(200), `%${filters.search}%`);
    whereExtra += ' AND (sk.EAN LIKE @search OR p.Product_dsc LIKE @search)';
  }

  const r = await req.query(`
    SELECT DISTINCT
      sk.EAN,
      sk.SKU_ID,
      sk.image_url,
      p.product_id,
      p.Product_dsc,
      p.Category_id,
      p.status,
      ec_cat.Category_dsc AS commercial_category_dsc
    FROM RETSC_OP_ENTERPRISE_SKUS es
    JOIN RETSC_OP_SKUS sk           ON sk.SKU_ID    = es.sku_id
    JOIN RETSC_OP_PRODUCTS p        ON p.product_id = sk.product_id
    LEFT JOIN RETSC_OP_ENTERPRISE_CATEGORIES entcat
           ON entcat.enterprise_category_id = es.selected_category_id
    LEFT JOIN RETSC_OP_CATEGORIES ec_cat
           ON ec_cat.Category_id = entcat.selected_category_id
    WHERE es.enterprise_id = @enterpriseId
    ${whereExtra}
    ORDER BY p.Product_dsc ASC
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

module.exports = { findById, findByGtinAndEnterprise, listByEnterprise, insert, insertMany, update };
