/**
 * admNoteRepo.js — Acceso a RETSC_ADM_COLLECTION_NOTE (notas de seguimiento de cobro).
 *
 * Para qué sirve: guardar y listar las notas que deja DTC al dar seguimiento a una factura
 *   (a quién se le escribió, qué respondió y cuándo volver a contactar).
 * Dependencias externas pendientes: ninguna. (Tabla ya verificada en QA.)
 * TODO conocidos:
 *   // TODO: preguntar a María si las notas deben quedar en la bitácora. Hoy NO se auditan
 *   //       porque la bitácora no acepta la entidad NOTE (ver NOTA abajo).
 *
 * NOTA: las notas NO se auditan. El CHECK CK_ADM_AUDIT_ENTITY de RETSC_ADM_AUDIT_LOG solo
 *   admite CONTRACT, PO, INVOICE, PAYMENT, DOCUMENT y BILLING_PROFILE, así que una fila con
 *   entidad NOTE sería rechazada. La propia nota ya guarda quién (Created_userid) y cuándo
 *   (Created_at). Por eso el alta es un INSERT simple, sin transacción: hay una sola escritura.
 * NOTA: las notas no se editan ni se borran (no hay rutas para eso). Este archivo solo inserta y lee.
 */

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_ADM_COLLECTION_NOTE';

// Notas de una factura, de la más reciente a la más antigua.
const listByInvoice = async (invoiceId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('invoiceId', sql.Int, invoiceId)
    .query(`
      SELECT * FROM ${TABLE}
      WHERE Invoice_id = @invoiceId
      ORDER BY Note_id DESC
    `);
  return r.recordset;
};

// Crea una nota y devuelve la fila insertada. Created_at en UTC, como el resto del módulo.
const create = async ({ invoiceId, note, nextContactDate, userId }) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('invoiceId', sql.Int, invoiceId)
    .input('note', sql.NVarChar(500), note)
    .input('nextContactDate', sql.VarChar(10), nextContactDate)
    .input('userId', sql.Int, userId)
    .query(`
      INSERT INTO ${TABLE} (Invoice_id, Note, Next_contact_date, Created_userid, Created_at)
      OUTPUT INSERTED.*
      VALUES (@invoiceId, @note, CAST(@nextContactDate AS date), @userId,
              CAST(SYSUTCDATETIME() AS datetime2(0)))
    `);
  return r.recordset[0];
};

module.exports = { listByInvoice, create };
