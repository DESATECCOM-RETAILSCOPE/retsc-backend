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
          INSERT INTO ${TABLE} (Enterprise_id, Category_id)
          OUTPUT INSERTED.*
          VALUES (@enterpriseId, @categoryId)
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

module.exports = { findByEnterprise, replaceForEnterprise };
