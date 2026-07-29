const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_ROLES';

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE Role_id = @id`);
  return r.recordset[0] ?? null;
};

// UPPER() explícito en ambos lados — la collation de esta BD es case-insensitive
// hoy (verificado), pero no queremos que la búsqueda de rol dependa de eso.
const findByName = async (name) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('name', sql.VarChar(80), name)
    .query(`SELECT * FROM ${TABLE} WHERE UPPER(Role_name) = UPPER(@name)`);
  return r.recordset[0] ?? null;
};

const listAll = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`SELECT * FROM ${TABLE}`);
  return r.recordset;
};

const insert = async (role) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('name',        sql.VarChar(30),  role.Role_name)
    .input('description', sql.VarChar(100), role.Description ?? null)
    .input('status',      sql.Bit,          role.Status ?? 1)
    .query(`
      INSERT INTO ${TABLE} (Role_name, Description, Status)
      OUTPUT INSERTED.*
      VALUES (@name, @description, @status)
    `);
  return r.recordset[0];
};

const update = async (id, partial) => {
  const pool = await getPool();
  const req = pool.request().input('id', sql.Int, id);
  const set = [];

  if (partial.Role_name   !== undefined) { req.input('name',        sql.VarChar(30),  partial.Role_name);   set.push('Role_name = @name'); }
  if (partial.Description !== undefined) { req.input('description', sql.VarChar(100), partial.Description); set.push('Description = @description'); }
  if (partial.Status      !== undefined) { req.input('status',      sql.Bit,          partial.Status);      set.push('Status = @status'); }

  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE ${TABLE} SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE Role_id = @id
  `);
  return r.recordset[0] ?? null;
};

module.exports = { findById, findByName, listAll, insert, update };
