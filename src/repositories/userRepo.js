const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_USERS';

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE User_id = @id`);
  return r.recordset[0] ?? null;
};

const findByEmail = async (email) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('email', sql.VarChar(120), email)
    .query(`SELECT * FROM ${TABLE} WHERE Email = @email`);
  return r.recordset[0] ?? null;
};

const findByCedula = async (ced) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('ced', sql.VarChar(50), ced)
    .query(`SELECT * FROM ${TABLE} WHERE ced_identidad = @ced`);
  return r.recordset[0] ?? null;
};

const listAll = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`SELECT * FROM ${TABLE}`);
  return r.recordset;
};

const insert = async (user) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('username',     sql.VarChar(80),  user.User_name)
    .input('email',        sql.VarChar(120), user.Email)
    .input('passwordHash', sql.VarChar(200), user.PasswordHash)
    .input('cedIdentidad', sql.VarChar(50),  user.ced_identidad ?? null)
    .input('status',       sql.Int,          user.Status ?? 1)
    .input('createdDate',  sql.VarChar(50),  user.Created_date ?? new Date().toISOString())
    .query(`
      INSERT INTO ${TABLE} (User_name, Email, PasswordHash, ced_identidad, Status, Created_date)
      OUTPUT INSERTED.*
      VALUES (@username, @email, @passwordHash, @cedIdentidad, @status, @createdDate)
    `);
  return r.recordset[0];
};

const update = async (id, partial) => {
  const pool = await getPool();
  const req = pool.request().input('id', sql.Int, id);
  const set = [];

  if (partial.User_name !== undefined)    { req.input('uname', sql.VarChar(80),  partial.User_name);    set.push('User_name = @uname'); }
  if (partial.Email !== undefined)        { req.input('email', sql.VarChar(120), partial.Email);         set.push('Email = @email'); }
  if (partial.PasswordHash !== undefined) { req.input('phash', sql.VarChar(200), partial.PasswordHash);  set.push('PasswordHash = @phash'); }
  if (partial.Status !== undefined)       { req.input('status', sql.Int,         partial.Status);        set.push('Status = @status'); }

  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE ${TABLE} SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE User_id = @id
  `);
  return r.recordset[0] ?? null;
};

// Preferencias personales del usuario (pantalla "Configuración" del mobile, 2026-10-21) —
// separado a propósito de update(): ese es para datos que un Admin administra sobre OTRO
// usuario (nombre/email/password/status); esto es self-service, el propio usuario sobre sí
// mismo (ver userPreferencesService.js y la ruta GET/PUT /api/users/me/preferences,
// declarada antes del gate de Admin en userRoutes.js).
const updatePreferences = async (id, { customRadiusEnabled, searchRadiusKm }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',                  sql.Int, id)
    .input('customRadiusEnabled', sql.Bit, customRadiusEnabled)
    .input('searchRadiusKm',      sql.Int, searchRadiusKm)
    .query(`
      UPDATE ${TABLE}
      SET custom_radius_enabled = @customRadiusEnabled,
          search_radius_km      = @searchRadiusKm
      OUTPUT INSERTED.*
      WHERE User_id = @id
    `);
  return r.recordset[0] ?? null;
};

const remove = async (id) => {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.Int, id)
    .query(`DELETE FROM ${TABLE} WHERE User_id = @id`);
  return true;
};

module.exports = { findById, findByEmail, findByCedula, listAll, insert, update, updatePreferences, remove };
