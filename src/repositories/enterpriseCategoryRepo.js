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

module.exports = {
  findByEnterprise,
  findByEnterpriseAndCategory,
  insertOne,
  deactivateByEnterprise,
  addForEnterprise,
};
