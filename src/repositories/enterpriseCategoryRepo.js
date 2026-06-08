const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_ENTERPRISE_CATEGORIES';

const findByEnterprise = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE Enterprise_id = @enterpriseId`);
  return r.recordset;
};

const replaceForEnterprise = async (enterpriseId, categoryIds) => {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();

  try {
    await transaction.request()
      .input('enterpriseId', sql.Int, enterpriseId)
      .query(`DELETE FROM ${TABLE} WHERE Enterprise_id = @enterpriseId`);

    const inserted = [];
    for (const catId of categoryIds) {
      const r = await transaction.request()
        .input('enterpriseId', sql.Int, enterpriseId)
        .input('categoryId',   sql.Int, catId)
        .query(`
          INSERT INTO ${TABLE} (enterprise_id, selected_category_id, status)
          OUTPUT INSERTED.*
          VALUES (@enterpriseId, @categoryId, 'ACTIVE')
        `);
      inserted.push(r.recordset[0]);
    }

    await transaction.commit();
    return inserted;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

// GET /api/enterprises/me/enterprise-categories
// enterprise_category_dsc no existe como columna; se obtiene de la categoría DTC seleccionada
const listCommercialCategories = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`
      SELECT
        ec.enterprise_category_id,
        ec.enterprise_id,
        ec.selected_category_id,
        ec.resolved_category_id,
        c.Category_dsc  AS enterprise_category_dsc
      FROM RETSC_OP_ENTERPRISE_CATEGORIES ec
      JOIN RETSC_OP_CATEGORIES c ON c.Category_id = ec.selected_category_id
      WHERE ec.enterprise_id = @enterpriseId
        AND ec.status = 'ACTIVE'
      ORDER BY c.Category_dsc ASC
    `);
  return r.recordset;
};

// Lookup individual — usado por skuService para obtener resolved_category_id
const findEnterpriseCategoryById = async (enterpriseCategoryId, enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',           sql.Int, enterpriseCategoryId)
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`
      SELECT enterprise_category_id, selected_category_id, resolved_category_id, status
      FROM RETSC_OP_ENTERPRISE_CATEGORIES
      WHERE enterprise_category_id = @id
        AND enterprise_id           = @enterpriseId
    `);
  return r.recordset[0] ?? null;
};

module.exports = {
  findByEnterprise,
  replaceForEnterprise,
  listCommercialCategories,
  findEnterpriseCategoryById,
};
