/**
 * admPaymentRepo.js — Acceso a RETSC_ADM_PAYMENT (pagos o transferencias recibidas).
 *
 * Para qué sirve: registrar pagos manuales de una factura, anularlos y listarlos. Cada
 *   escritura corre en una transacción que incluye la fila de bitácora, y devuelve el saldo
 *   actualizado de la factura leído de RETSC_ADM_V_INVOICE_BALANCE en esa misma transacción.
 * Dependencias externas pendientes: ninguna. (Tabla, vista e índices ya verificados en QA.)
 * TODO conocidos:
 *   // TODO: comprobante de pago (Document_id) cuando exista el servicio de documentos.
 *   //       Hoy se guarda siempre en NULL.
 *   // TODO: Source = 'PASARELA' y Gateway_txn_id cuando exista la pasarela de pago.
 *
 * NOTA: igual que en admInvoiceRepo, las reglas que dependen de la suma de pagos se revisan
 *   dentro de la transacción mediante la función `checkLocked` que entrega el servicio.
 * NOTA: los pagos no se borran nunca (regla de la spec): anular = Status 'ANULADO' + motivo.
 *   Este archivo no tiene DELETE a propósito.
 */

const { getPool, sql } = require('../config/db');
const auditRepo = require('./admAuditRepo');
const invoiceRepo = require('./admInvoiceRepo');

const TABLE = 'RETSC_ADM_PAYMENT';
const INVOICE_TABLE = 'RETSC_ADM_INVOICE';

// Un pago por su id, o null.
const findById = async (paymentId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('paymentId', sql.Int, paymentId)
    .query(`SELECT * FROM ${TABLE} WHERE Payment_id = @paymentId`);
  return r.recordset[0] ?? null;
};

// Todos los pagos de una factura (APLICADO y ANULADO), del más reciente al más antiguo.
const listByInvoice = async (invoiceId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('invoiceId', sql.Int, invoiceId)
    .query(`
      SELECT * FROM ${TABLE}
      WHERE Invoice_id = @invoiceId
      ORDER BY Payment_date DESC, Payment_id DESC
    `);
  return r.recordset;
};

// Registra un pago en una sola transacción:
//   1. Lee la factura BLOQUEADA (UPDLOCK). Así, si llegan dos pagos al mismo tiempo para
//      la misma factura, el segundo espera a que termine el primero y ve su suma.
//   2. Suma los pagos APLICADO de esa factura (ya con la fila bloqueada).
//   3. checkLocked({ invoice, appliedTotal }) del servicio valida estado, moneda y saldo.
//   4. INSERT del pago + bitácora CREATE (entidad PAYMENT).
//   5. Lee el saldo actualizado de la vista.
// Devuelve { row, balance }. 404 si la factura no existe.
const createWithAudit = async (invoiceId, rec, { userId, ipAddress }, checkLocked) => {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    // --- 1. Factura bloqueada ---
    const cur = await transaction
      .request()
      .input('invoiceId', sql.Int, invoiceId)
      .query(`SELECT * FROM ${INVOICE_TABLE} WITH (UPDLOCK, ROWLOCK) WHERE Invoice_id = @invoiceId`);
    const invoice = cur.recordset[0];
    if (!invoice) {
      const notFound = new Error('Factura no encontrada.');
      notFound.statusCode = 404;
      throw notFound;
    }

    // --- 2 y 3. Suma de pagos y reglas del servicio ---
    const appliedTotal = await invoiceRepo.sumAppliedPaymentsInTransaction(transaction, invoiceId);
    await checkLocked({ invoice, appliedTotal });

    // --- 4. Alta del pago ---
    const ins = await transaction
      .request()
      .input('invoiceId', sql.Int, invoiceId)
      .input('paymentDate', sql.VarChar(10), rec.paymentDate)
      .input('amount', sql.Decimal(18, 2), rec.amount)
      .input('currency', sql.Char(3), rec.currency)
      .input('method', sql.VarChar(15), rec.method)
      .input('reference', sql.VarChar(100), rec.reference)
      .input('bank', sql.VarChar(80), rec.bank)
      .input('userId', sql.Int, userId)
      .query(`
        INSERT INTO ${TABLE}
          (Invoice_id, Payment_date, Amount, Currency, Method, Reference, Bank,
           Source, Status, Recorded_userid, Recorded_at)
        OUTPUT INSERTED.*
        VALUES
          (@invoiceId, CAST(@paymentDate AS date), @amount, @currency, @method, @reference, @bank,
           'MANUAL', 'APLICADO', @userId, CAST(SYSUTCDATETIME() AS datetime2(0)))
      `);
    const row = ins.recordset[0];

    await auditRepo.insertInTransaction(transaction, {
      entityType: 'PAYMENT',
      entityId: row.Payment_id,
      action: 'CREATE',
      newValue: row,
      userId,
      ipAddress,
    });

    // --- 5. Saldo actualizado (incluye el pago recién insertado) ---
    const balance = await invoiceRepo.findBalanceInTransaction(transaction, invoiceId);

    await transaction.commit();
    return { row, balance };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

// Anula un pago en una sola transacción:
//   1. Lee el pago BLOQUEADO (UPDLOCK) para que dos anulaciones simultáneas no choquen.
//   2. checkLocked({ payment }) del servicio valida que esté APLICADO.
//   3. UPDATE a ANULADO con motivo + bitácora VOID (entidad PAYMENT).
//   4. Lee el saldo actualizado de la factura.
// Devuelve { row, balance }. 404 si el pago no existe.
const voidWithAudit = async (paymentId, voidReason, { userId, ipAddress }, checkLocked) => {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    // --- 1. Pago bloqueado ---
    const cur = await transaction
      .request()
      .input('paymentId', sql.Int, paymentId)
      .query(`SELECT * FROM ${TABLE} WITH (UPDLOCK, ROWLOCK) WHERE Payment_id = @paymentId`);
    const payment = cur.recordset[0];
    if (!payment) {
      const notFound = new Error('Pago no encontrado.');
      notFound.statusCode = 404;
      throw notFound;
    }

    // --- 2. Reglas del servicio ---
    await checkLocked({ payment });

    // --- 3. Anulación ---
    const upd = await transaction
      .request()
      .input('paymentId', sql.Int, paymentId)
      .input('voidReason', sql.NVarChar(255), voidReason)
      .query(`
        UPDATE ${TABLE}
        SET Status = 'ANULADO', Void_reason = @voidReason
        OUTPUT INSERTED.*
        WHERE Payment_id = @paymentId
      `);
    const row = upd.recordset[0];

    await auditRepo.insertInTransaction(transaction, {
      entityType: 'PAYMENT',
      entityId: paymentId,
      action: 'VOID',
      oldValue: { Status: payment.Status, Void_reason: payment.Void_reason ?? null },
      newValue: { Status: row.Status, Void_reason: row.Void_reason },
      userId,
      ipAddress,
    });

    // --- 4. Saldo actualizado de la factura ---
    const balance = await invoiceRepo.findBalanceInTransaction(transaction, row.Invoice_id);

    await transaction.commit();
    return { row, balance };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

module.exports = { findById, listByInvoice, createWithAudit, voidWithAudit };
