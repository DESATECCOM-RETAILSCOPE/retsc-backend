/**
 * admBillingProfileRepo.js — Acceso a RETSC_ADM_BILLING_PROFILE (datos de facturación).
 *
 * Para qué sirve: leer y guardar los datos de facturación de una empresa. La tabla
 *   tiene UNA fila por empresa (la llave primaria es Enterprise_id), así que guardar
 *   significa crear la fila si no existe o actualizarla si ya existe (upsert).
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 *
 * NOTA: Updated_at se guarda en UTC con SYSUTCDATETIME(), igual que el resto del módulo.
 */

const { getPool, sql } = require('../config/db');
const auditRepo = require('./admAuditRepo');

const TABLE = 'RETSC_ADM_BILLING_PROFILE';

// Datos de facturación de la empresa, o null si todavía no se han cargado.
const findByEnterprise = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE Enterprise_id = @enterpriseId`);
  return r.recordset[0] ?? null;
};

// Guarda los datos de facturación (crea o actualiza) y la bitácora, todo en una transacción.
// Devuelve { row, created, previous }: created = true si fue un alta nueva.
const upsertWithAudit = async (rec, { userId, ipAddress }) => {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    // Lee la fila actual con UPDLOCK + HOLDLOCK: bloquea el rango de esa llave, incluso si
    // todavía no existe, para que dos peticiones simultáneas no intenten insertar la misma.
    const cur = await transaction
      .request()
      .input('enterpriseId', sql.Int, rec.enterpriseId)
      .query(`SELECT * FROM ${TABLE} WITH (UPDLOCK, HOLDLOCK) WHERE Enterprise_id = @enterpriseId`);
    const previous = cur.recordset[0] ?? null;

    // Los mismos parámetros sirven para INSERT y UPDATE.
    const req = transaction
      .request()
      .input('enterpriseId', sql.Int, rec.enterpriseId)
      .input('legalName', sql.NVarChar(150), rec.legalName)
      .input('taxId', sql.VarChar(30), rec.taxId)
      .input('billingEmail', sql.VarChar(150), rec.billingEmail)
      .input('billingAddress', sql.NVarChar(255), rec.billingAddress)
      .input('country', sql.Char(2), rec.country)
      .input('userId', sql.Int, userId);

    let result;
    if (previous) {
      result = await req.query(`
        UPDATE ${TABLE}
        SET Legal_name = @legalName, Tax_id = @taxId, Billing_email = @billingEmail,
            Billing_address = @billingAddress, Country = @country,
            Updated_at = CAST(SYSUTCDATETIME() AS datetime2(0)), Updated_userid = @userId
        OUTPUT INSERTED.*
        WHERE Enterprise_id = @enterpriseId
      `);
    } else {
      result = await req.query(`
        INSERT INTO ${TABLE}
          (Enterprise_id, Legal_name, Tax_id, Billing_email, Billing_address, Country,
           Updated_at, Updated_userid)
        OUTPUT INSERTED.*
        VALUES
          (@enterpriseId, @legalName, @taxId, @billingEmail, @billingAddress, @country,
           CAST(SYSUTCDATETIME() AS datetime2(0)), @userId)
      `);
    }
    const row = result.recordset[0];

    // El perfil no tiene un id propio: su identificador es el Enterprise_id.
    await auditRepo.insertInTransaction(transaction, {
      entityType: 'BILLING_PROFILE',
      entityId: rec.enterpriseId,
      action: previous ? 'UPDATE' : 'CREATE',
      oldValue: previous,
      newValue: row,
      userId,
      ipAddress,
    });

    await transaction.commit();
    return { row, created: !previous, previous };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

module.exports = { findByEnterprise, upsertWithAudit };
