// Repositorio para RETSC_EX_VISIT (Paso 0 de la guía "Fotos de Visita" v1.9, María Royo).
//
// Tabla nueva — no existía en el repo hasta esta migración (008_create_visit_photo_pipeline.sql).
// Sin categoría ni canal a propósito: una visita cubre varias categorías bajo el mismo
// Visit_id; el canal se resuelve por Retailer_id (ver retailerRepo.js), nunca se guarda aquí.
//
// TEMPORAL — RETSC_OP_RETAILER (de donde saldría el canal) no está confirmada en el
// esquema real de este repo (ver retailerRepo.js y CLAUDE.md); no bloquea abrir/cerrar
// visitas porque este repo no la necesita para eso.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_EX_VISIT';

// Abre una visita nueva. Devuelve la fila creada (incluye Visit_id).
const open = async ({ userId, enterpriseId, retailerId, latitude, longitude }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId',       sql.Int,           userId)
    .input('enterpriseId', sql.Int,           enterpriseId)
    .input('retailerId',   sql.Int,           retailerId)
    .input('latitude',     sql.Decimal(9, 6), latitude ?? null)
    .input('longitude',    sql.Decimal(9, 6), longitude ?? null)
    .query(`
      INSERT INTO ${TABLE}
        (User_id, Enterprise_id, Retailer_id, Visit_start, Latitude, Longitude, Status)
      OUTPUT INSERTED.*
      VALUES
        (@userId, @enterpriseId, @retailerId, GETDATE(), @latitude, @longitude, 'OPEN')
    `);
  return r.recordset[0];
};

// Cierra una visita ya abierta. Devuelve la fila actualizada, o null si no existía.
// No valida aquí que Status sea 'OPEN' antes de cerrar — eso lo decide visitService
// (409 si ya está CLOSED) para poder dar un mensaje de error específico.
const close = async (visitId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, visitId)
    .query(`
      UPDATE ${TABLE}
      SET Visit_end = GETDATE(), Status = 'CLOSED'
      OUTPUT INSERTED.*
      WHERE Visit_id = @id
    `);
  return r.recordset[0] ?? null;
};

const findById = async (visitId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, visitId)
    .query(`SELECT * FROM ${TABLE} WHERE Visit_id = @id`);
  return r.recordset[0] ?? null;
};

// Todas las visitas abiertas de un usuario (para que el mobile pueda "retomar" una visita
// en curso en vez de abrir otra sin querer). No es parte explícita de la guía, pero
// visitService.openVisit() la usa para dar un 409 claro en vez de acumular visitas huérfanas.
const findOpenByUser = async (userId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT * FROM ${TABLE} WHERE User_id = @userId AND Status = 'OPEN'`);
  return r.recordset;
};

module.exports = { open, close, findById, findOpenByUser };
