const { getPool, sql } = require("../config/db");

const TABLE = "RETSC_OP_ENTERPRISE_CATEGORIES";

const findByEnterprise = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request().input("enterpriseId", sql.Int, enterpriseId)
    .query(`
      SELECT * FROM ${TABLE}
      WHERE enterprise_id = @enterpriseId
        AND status = 'ACTIVE'
      ORDER BY created_at DESC
    `);
  return r.recordset;
};

const findByEnterpriseAndCategory = async (
  enterpriseId,
  selectedCategoryId,
) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("enterpriseId", sql.Int, enterpriseId)
    .input("selectedCategoryId", sql.Int, selectedCategoryId).query(`
      SELECT * FROM ${TABLE}
      WHERE enterprise_id       = @enterpriseId
        AND selected_category_id = @selectedCategoryId
        AND status               = 'ACTIVE'
    `);
  return r.recordset;
};

const insertOne = async (record) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("enterpriseId", sql.Int, record.enterprise_id)
    .input("selectedCategoryId", sql.Int, record.selected_category_id)
    .input("resolvedCategoryId", sql.Int, record.resolved_category_id ?? null)
    .input("resolutionType", sql.VarChar(20), record.resolution_type ?? null)
    .input("status", sql.VarChar(20), record.status ?? "ACTIVE")
    .input("createdAt", sql.DateTime, record.created_at ?? new Date()).query(`
      INSERT INTO ${TABLE}
        (enterprise_id, selected_category_id, resolved_category_id, resolution_type, status, created_at)
      OUTPUT INSERTED.*
      VALUES
        (@enterpriseId, @selectedCategoryId, @resolvedCategoryId, @resolutionType, @status, @createdAt)
    `);
  return r.recordset[0];
};

const deactivateByEnterprise = async (enterpriseId) => {
  const pool = await getPool();
  await pool.request().input("enterpriseId", sql.Int, enterpriseId).query(`
      UPDATE ${TABLE}
      SET status = 'INACTIVE'
      WHERE enterprise_id = @enterpriseId
        AND status = 'ACTIVE'
    `);
};

// Solo inserta los registros nuevos — NO inactiva nada de lo existente
const addForEnterprise = async (enterpriseId, records) => {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const inserted = [];
    const now = new Date();
    for (const rec of records) {
      const r = await transaction
        .request()
        .input("enterpriseId", sql.Int, enterpriseId)
        .input("selectedCategoryId", sql.Int, rec.selected_category_id)
        .input("resolvedCategoryId", sql.Int, rec.resolved_category_id ?? null)
        .input("resolutionType", sql.VarChar(20), rec.resolution_type ?? null)
        .input("activeStatus", sql.VarChar(20), "ACTIVE")
        .input("createdAt", sql.DateTime, now).query(`
          INSERT INTO ${TABLE}
            (enterprise_id, selected_category_id, resolved_category_id, resolution_type, status, created_at)
          OUTPUT INSERTED.*
          VALUES
            (@enterpriseId, @selectedCategoryId, @resolvedCategoryId, @resolutionType, @activeStatus, @createdAt)
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
  const r = await pool.request().input("enterpriseId", sql.Int, enterpriseId)
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
const findEnterpriseCategoryById = async (
  enterpriseCategoryId,
  enterpriseId,
) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("id", sql.Int, enterpriseCategoryId)
    .input("enterpriseId", sql.Int, enterpriseId).query(`
      SELECT enterprise_category_id, selected_category_id, resolved_category_id, status
      FROM RETSC_OP_ENTERPRISE_CATEGORIES
      WHERE enterprise_category_id = @id
        AND enterprise_id           = @enterpriseId
    `);
  return r.recordset[0] ?? null;
};

module.exports = {
  findByEnterprise,
  findByEnterpriseAndCategory,
  insertOne,
  deactivateByEnterprise,
  addForEnterprise,
  listCommercialCategories,
  findEnterpriseCategoryById,
};
