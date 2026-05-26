const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_USRSXENTERP';

const findActiveByUserId = async (userId, currentDate) => {
  const now = currentDate ? new Date(currentDate) : new Date();
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('now',    sql.DateTime2, now)
    .query(`
      SELECT * FROM ${TABLE}
      WHERE User_id = @userId
        AND Status = 1
        AND Fecha_activacion <= @now
        AND (Fecha_inactivacion IS NULL OR Fecha_inactivacion > @now)
    `);
  return r.recordset;
};

const findByEnterprise = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE Enterprise_id = @enterpriseId`);
  return r.recordset;
};

const findByUserAndEnterprise = async (userId, enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId',       sql.Int, userId)
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE User_id = @userId AND Enterprise_id = @enterpriseId`);
  return r.recordset[0] ?? null;
};

const insert = async (relation) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId',       sql.Int,          relation.User_id)
    .input('enterpriseId', sql.Int,          relation.Enterprise_id)
    .input('roleId',       sql.Int,          relation.Role_id)
    .input('status',       sql.Int,          relation.Status ?? 1)
    .input('activation',   sql.VarChar(50),  relation.Fecha_activacion ?? new Date().toISOString())
    .input('inactivation', sql.VarChar(50),  relation.Fecha_inactivacion ?? null)
    .query(`
      INSERT INTO ${TABLE} (User_id, Enterprise_id, Role_id, Status, Fecha_activacion, Fecha_inactivacion)
      OUTPUT INSERTED.*
      VALUES (@userId, @enterpriseId, @roleId, @status, @activation, @inactivation)
    `);
  return r.recordset[0];
};

const update = async (id, partial) => {
  const pool = await getPool();
  const req = pool.request().input('id', sql.Int, id);
  const set = [];

  if (partial.Status !== undefined)             { req.input('status',       sql.Int,         partial.Status);             set.push('Status = @status'); }
  if (partial.Role_id !== undefined)            { req.input('roleId',       sql.Int,         partial.Role_id);            set.push('Role_id = @roleId'); }
  if (partial.Fecha_inactivacion !== undefined) { req.input('inactivation', sql.VarChar(50), partial.Fecha_inactivacion); set.push('Fecha_inactivacion = @inactivation'); }

  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE ${TABLE} SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE Id = @id
  `);
  return r.recordset[0] ?? null;
};

module.exports = { findActiveByUserId, findByEnterprise, findByUserAndEnterprise, insert, update };
