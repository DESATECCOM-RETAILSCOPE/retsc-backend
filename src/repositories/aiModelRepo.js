const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_AI_DETECTION_MODELS';

const findActiveByCategory = async (categoryId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int,         categoryId)
    .input('status',     sql.VarChar(50), 'active')
    .query(`SELECT * FROM ${TABLE} WHERE Category_id = @categoryId AND Status = @status`);
  return r.recordset;
};

const listAll = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`SELECT * FROM ${TABLE}`);
  return r.recordset;
};

const insert = async (model) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId',         sql.Int,         model.Category_id)
    .input('status',             sql.VarChar(50), model.Status ?? 'pending_training')
    .input('version',            sql.VarChar(20), model.Version ?? '1.0')
    .input('pendingImagesCount', sql.Int,         model.Pending_images_count ?? 0)
    .input('createdDate',        sql.VarChar(50), model.Created_date ?? new Date().toISOString())
    .input('updatedDate',        sql.VarChar(50), model.Updated_date ?? new Date().toISOString())
    .query(`
      INSERT INTO ${TABLE} (Category_id, Status, Version, Pending_images_count, Created_date, Updated_date)
      OUTPUT INSERTED.*
      VALUES (@categoryId, @status, @version, @pendingImagesCount, @createdDate, @updatedDate)
    `);
  return r.recordset[0];
};

const update = async (id, partial) => {
  const pool = await getPool();
  const req = pool.request().input('id', sql.Int, id);
  const set = [];

  if (partial.Status !== undefined)               { req.input('status',  sql.VarChar(50), partial.Status);               set.push('Status = @status'); }
  if (partial.Version !== undefined)              { req.input('version', sql.VarChar(20), partial.Version);              set.push('Version = @version'); }
  if (partial.Pending_images_count !== undefined) { req.input('count',   sql.Int,         partial.Pending_images_count); set.push('Pending_images_count = @count'); }
  if (partial.Updated_date !== undefined)         { req.input('upd',     sql.VarChar(50), partial.Updated_date);         set.push('Updated_date = @upd'); }

  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE ${TABLE} SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE Model_id = @id
  `);
  return r.recordset[0] ?? null;
};

module.exports = { findActiveByCategory, listAll, insert, update };
