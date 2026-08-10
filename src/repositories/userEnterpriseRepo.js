const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_USRSXENTERP';

// ORDER BY Fecha_activacion ASC: authService.js necesita poder tomar "la relación más
// antigua" de forma determinística cuando un usuario tiene más de una empresa activa.
// RETSC_OP_USRSXENTERP no tiene columna Id/PK propia (verificado con INFORMATION_SCHEMA:
// User_id, Enterprise_id, Role_id, Status, Fecha_activacion, Fecha_inactivacion, Phone) —
// sin este ORDER BY, el orden de las filas es el que decida devolver SQL Server, no
// necesariamente el de creación. Enterprise_id ASC como desempate estable si dos
// relaciones comparten Fecha_activacion.
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
      ORDER BY Fecha_activacion ASC, Enterprise_id ASC
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

const update = async (userId, enterpriseId, partial) => {
  const pool = await getPool();
  const req = pool.request()
    .input('userId',       sql.Int, userId)
    .input('enterpriseId', sql.Int, enterpriseId);
  const set = [];

  if (partial.Status !== undefined)             { req.input('status',       sql.Int,         partial.Status);             set.push('Status = @status'); }
  if (partial.Role_id !== undefined)            { req.input('roleId',       sql.Int,         partial.Role_id);            set.push('Role_id = @roleId'); }
  if (partial.Fecha_activacion !== undefined)   { req.input('activation',   sql.VarChar(50), partial.Fecha_activacion);   set.push('Fecha_activacion = @activation'); }
  if (partial.Fecha_inactivacion !== undefined) { req.input('inactivation', sql.VarChar(50), partial.Fecha_inactivacion); set.push('Fecha_inactivacion = @inactivation'); }

  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE ${TABLE} SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE User_id = @userId AND Enterprise_id = @enterpriseId
  `);
  return r.recordset[0] ?? null;
};

// Listado global cross-empresa (menú por rol 2026-07-25, ítem "Usuarios globales" de
// ADMIN_DTC). A diferencia de findByEnterprise + el enriquecimiento N+1 que hace
// userService.listByEnterprise (un findById de usuario y otro de rol POR relación),
// acá se resuelve todo en un solo JOIN — a escala global (todas las empresas, todos los
// usuarios) el N+1 se vuelve costoso rápido, y el shape de salida es simple (usuario +
// rol + empresa), sin la lógica condicional que sí justificaba el loop en otros lados.
// LEFT JOIN en rol/empresa (no INNER) para no perder la fila si alguna quedó huérfana de
// esas FKs — se prioriza que el listado nunca sea más corto que RETSC_OP_USRSXENTERP.
const findAllGlobal = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT
      u.User_id, u.User_name, u.Email, u.ced_identidad,
      r.Role_id, r.Role_name,
      ux.Enterprise_id, ux.Status, ux.Fecha_activacion, ux.Fecha_inactivacion,
      e.Enterprise_dsc
    FROM ${TABLE} ux
    JOIN RETSC_OP_USERS u
      ON u.User_id = ux.User_id
    LEFT JOIN RETSC_OP_ROLES r
      ON r.Role_id = ux.Role_id
    LEFT JOIN RETSC_OP_ENTERPRISE e
      ON e.Enterprise_id = ux.Enterprise_id
    ORDER BY e.Enterprise_dsc ASC, u.User_name ASC
  `);
  return r.recordset;
};

module.exports = { findActiveByUserId, findByEnterprise, findByUserAndEnterprise, insert, update, findAllGlobal };
