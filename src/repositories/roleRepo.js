const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_ROLES';

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE Role_id = @id`);
  return r.recordset[0] ?? null;
};

const findByName = async (name) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('name', sql.VarChar(80), name)
    .query(`SELECT * FROM ${TABLE} WHERE Role_name = @name`);
  return r.recordset[0] ?? null;
};

const listAll = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`SELECT * FROM ${TABLE}`);
  return r.recordset;
};

module.exports = { findById, findByName, listAll };
