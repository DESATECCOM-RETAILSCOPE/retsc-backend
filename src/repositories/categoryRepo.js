const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_CATEGORIES';

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE Category_id = @id`);
  return r.recordset[0] ?? null;
};

const listActive = async () => {
  const pool = await getPool();
  const r = await pool.request()
    .query(`SELECT * FROM ${TABLE} WHERE Status = 1`);
  return r.recordset;
};

module.exports = { findById, listActive };
