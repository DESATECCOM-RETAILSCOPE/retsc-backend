/**
 * admInvoiceRepo.js — Acceso a RETSC_ADM_INVOICE (facturas registradas) y a la vista de saldos.
 *
 * Para qué sirve: registrar facturas, cambiar su estado y listarlas con su saldo
 *   (vista RETSC_ADM_V_INVOICE_BALANCE). Cada escritura corre en una transacción que
 *   incluye la fila de bitácora (regla de la especificación, sección 6).
 * Dependencias externas pendientes: ninguna. (Tablas, vista e índices ya verificados en QA.)
 * TODO conocidos:
 *   // TODO: adjuntos PDF/XML (Document_pdf_id / Document_xml_id) cuando exista el
 *   //       servicio de documentos. Hoy se guardan siempre en NULL.
 *   // TODO: paginación del listado cuando el volumen lo pida.
 *
 * NOTA: las reglas que dependen de datos que pueden cambiar mientras se escribe (saldo de
 *   la OC, suma de pagos) se revisan DENTRO de la transacción, con las filas bloqueadas.
 *   Para no mover la lógica de negocio al repositorio, el servicio entrega una función
 *   `checkLocked(estado)` que este archivo llama con lo leído bajo bloqueo: si lanza un
 *   error, se hace rollback y el error sube tal cual al servicio.
 * NOTA: este repositorio también lee y cierra la orden de compra (RETSC_ADM_PURCHASE_ORDER)
 *   porque el cierre debe ocurrir en la MISMA transacción que el alta de la factura y todavía
 *   no existe un admPurchaseOrderRepo (las OC llegan en otro paso). Cuando exista, mover
 *   estas consultas allá y recibir la transacción como parámetro, igual que admAuditRepo.
 * NOTA: Due_date es una columna calculada por la base. No se envía: se lee después del
 *   INSERT, dentro de la misma transacción.
 */

const { getPool, sql } = require('../config/db');
const auditRepo = require('./admAuditRepo');

const TABLE = 'RETSC_ADM_INVOICE';
const PO_TABLE = 'RETSC_ADM_PURCHASE_ORDER';
const PAYMENT_TABLE = 'RETSC_ADM_PAYMENT';
const BALANCE_VIEW = 'RETSC_ADM_V_INVOICE_BALANCE';

// "Hoy" en hora de Costa Rica (UTC-6, sin horario de verano), como pide la spec (sección 8).
// Se arma en SQL para que no dependa de la zona horaria del servidor Node.
const TODAY_CR_SQL = "CAST(SWITCHOFFSET(SYSDATETIMEOFFSET(), '-06:00') AS date)";

// Una factura por su id (de la tabla, no de la vista: incluye las ANULADA), o null.
const findById = async (invoiceId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('invoiceId', sql.Int, invoiceId)
    .query(`SELECT * FROM ${TABLE} WHERE Invoice_id = @invoiceId`);
  return r.recordset[0] ?? null;
};

// Lista de facturas de una empresa con su saldo, desde la vista (que excluye las ANULADA).
// Los filtros son opcionales y siempre parametrizados; solo se agrega al WHERE lo que viene.
//   status        : estado de la factura (REGISTRADA, ENVIADA, EN_DISPUTA)
//   currency      : CRC | USD
//   overdue       : true = solo vencidas (Days_overdue > 0)
//   dueWithinDays : N = vencen entre hoy y hoy + N días y todavía tienen saldo
const listBalanceByEnterprise = async (enterpriseId, { status, currency, overdue, dueWithinDays } = {}) => {
  const pool = await getPool();
  const req = pool.request().input('enterpriseId', sql.Int, enterpriseId);
  const where = ['Enterprise_id = @enterpriseId'];

  if (status) {
    req.input('status', sql.VarChar(15), status);
    where.push('Status = @status');
  }
  if (currency) {
    req.input('currency', sql.Char(3), currency);
    where.push('Currency = @currency');
  }
  if (overdue) {
    where.push('Days_overdue > 0');
  }
  if (dueWithinDays != null) {
    req.input('dueWithinDays', sql.Int, dueWithinDays);
    where.push(
      `Due_date >= ${TODAY_CR_SQL}`,
      `Due_date <= DATEADD(DAY, @dueWithinDays, ${TODAY_CR_SQL})`,
      'Balance > 0',
    );
  }

  const r = await req.query(`
    SELECT * FROM ${BALANCE_VIEW}
    WHERE ${where.join(' AND ')}
    ORDER BY Due_date ASC, Invoice_id ASC
  `);
  return r.recordset;
};

// Saldo de UNA factura desde la vista, usando la transacción abierta (para leer lo que
// la propia transacción acaba de escribir). Devuelve null si la factura está ANULADA.
const findBalanceInTransaction = async (transaction, invoiceId) => {
  const r = await transaction
    .request()
    .input('invoiceId', sql.Int, invoiceId)
    .query(`SELECT * FROM ${BALANCE_VIEW} WHERE Invoice_id = @invoiceId`);
  return r.recordset[0] ?? null;
};

// Suma de pagos APLICADO de una factura, dentro de la transacción. Devuelve un número.
const sumAppliedPaymentsInTransaction = async (transaction, invoiceId) => {
  const r = await transaction
    .request()
    .input('invoiceId', sql.Int, invoiceId)
    .query(`
      SELECT COALESCE(SUM(Amount), 0) AS total
      FROM ${PAYMENT_TABLE}
      WHERE Invoice_id = @invoiceId AND Status = 'APLICADO'
    `);
  return Number(r.recordset[0].total);
};

// Registra una factura en una sola transacción:
//   1. Si trae OC: la lee BLOQUEADA (UPDLOCK) y suma las facturas no anuladas ligadas a ella.
//      El bloqueo hace que dos facturas simultáneas contra la misma OC se procesen en fila.
//   2. Llama a checkLocked({ po, poInvoicedTotal }) del servicio, que valida y responde
//      { closePo } (true si con esta factura la OC llega exactamente a su monto).
//   3. Inserta la factura y la vuelve a leer para obtener Due_date (calculada por la base).
//   4. Bitácora CREATE de la factura.
//   5. Si closePo: pasa la OC a CERRADA y deja su bitácora STATUS_CHANGE.
// Devuelve { row, poClosed }.
const createWithAudit = async (rec, { userId, ipAddress }, checkLocked) => {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    // --- 1. OC bloqueada y lo ya facturado contra ella ---
    let po = null;
    let poInvoicedTotal = 0;
    if (rec.poId != null) {
      const poRes = await transaction
        .request()
        .input('poId', sql.Int, rec.poId)
        .query(`SELECT * FROM ${PO_TABLE} WITH (UPDLOCK, ROWLOCK) WHERE PO_id = @poId`);
      po = poRes.recordset[0] ?? null;

      if (po) {
        const sumRes = await transaction
          .request()
          .input('poId', sql.Int, rec.poId)
          .query(`
            SELECT COALESCE(SUM(Total_amount), 0) AS total
            FROM ${TABLE}
            WHERE PO_id = @poId AND Status <> 'ANULADA'
          `);
        poInvoicedTotal = Number(sumRes.recordset[0].total);
      }
    }

    // --- 2. Reglas del servicio con los datos bloqueados ---
    const { closePo } = (await checkLocked({ po, poInvoicedTotal })) || {};

    // --- 3. Alta de la factura ---
    const ins = await transaction
      .request()
      .input('enterpriseId', sql.Int, rec.enterpriseId)
      .input('contractId', sql.Int, rec.contractId)
      .input('poId', sql.Int, rec.poId)
      .input('invoiceNumber', sql.VarChar(50), rec.invoiceNumber)
      .input('invoiceKey', sql.VarChar(60), rec.invoiceKey)
      .input('issueDate', sql.VarChar(10), rec.issueDate)
      .input('receivedDate', sql.VarChar(10), rec.receivedDate)
      .input('creditDays', sql.Int, rec.creditDays)
      .input('subtotal', sql.Decimal(18, 2), rec.subtotal)
      .input('taxAmount', sql.Decimal(18, 2), rec.taxAmount)
      .input('totalAmount', sql.Decimal(18, 2), rec.totalAmount)
      .input('currency', sql.Char(3), rec.currency)
      .input('periodFrom', sql.VarChar(10), rec.periodFrom)
      .input('periodTo', sql.VarChar(10), rec.periodTo)
      .input('userId', sql.Int, userId)
      .query(`
        INSERT INTO ${TABLE}
          (Enterprise_id, Contract_id, PO_id, Invoice_number, Invoice_key, Issue_date,
           Received_date, Credit_days, Subtotal, Tax_amount, Total_amount, Currency,
           Status, Period_from, Period_to, Created_at, Created_userid)
        OUTPUT INSERTED.Invoice_id
        VALUES
          (@enterpriseId, @contractId, @poId, @invoiceNumber, @invoiceKey, CAST(@issueDate AS date),
           CAST(@receivedDate AS date), @creditDays, @subtotal, @taxAmount, @totalAmount, @currency,
           'REGISTRADA', CAST(@periodFrom AS date), CAST(@periodTo AS date),
           CAST(SYSUTCDATETIME() AS datetime2(0)), @userId)
      `);
    const invoiceId = ins.recordset[0].Invoice_id;

    // Se relee la fila completa para traer Due_date, que la calcula la base.
    const sel = await transaction
      .request()
      .input('invoiceId', sql.Int, invoiceId)
      .query(`SELECT * FROM ${TABLE} WHERE Invoice_id = @invoiceId`);
    const row = sel.recordset[0];

    // --- 4. Bitácora de la factura ---
    await auditRepo.insertInTransaction(transaction, {
      entityType: 'INVOICE',
      entityId: invoiceId,
      action: 'CREATE',
      newValue: row,
      userId,
      ipAddress,
    });

    // --- 5. Cierre de la OC si llegó exactamente a su monto ---
    if (closePo && po) {
      await transaction
        .request()
        .input('poId', sql.Int, po.PO_id)
        .query(`UPDATE ${PO_TABLE} SET Status = 'CERRADA' WHERE PO_id = @poId`);
      await auditRepo.insertInTransaction(transaction, {
        entityType: 'PO',
        entityId: po.PO_id,
        action: 'STATUS_CHANGE',
        oldValue: { Status: po.Status },
        newValue: { Status: 'CERRADA' },
        userId,
        ipAddress,
      });
    }

    await transaction.commit();
    return { row, poClosed: Boolean(closePo && po) };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

// Cambia el estado de una factura en una sola transacción:
//   1. Lee la factura BLOQUEADA (UPDLOCK) y la suma de sus pagos APLICADO.
//   2. checkLocked({ invoice, appliedTotal }) del servicio valida la transición.
//   3. UPDATE del estado (y Void_reason si es ANULADA) + bitácora (VOID o STATUS_CHANGE)
//      con solo los campos que cambiaron.
// Devuelve la fila actualizada. 404 si la factura no existe.
const changeStatusWithAudit = async (invoiceId, { status, voidReason }, { userId, ipAddress }, checkLocked) => {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    // --- 1. Factura bloqueada ---
    const cur = await transaction
      .request()
      .input('invoiceId', sql.Int, invoiceId)
      .query(`SELECT * FROM ${TABLE} WITH (UPDLOCK, ROWLOCK) WHERE Invoice_id = @invoiceId`);
    const invoice = cur.recordset[0];
    if (!invoice) {
      const notFound = new Error('Factura no encontrada.');
      notFound.statusCode = 404;
      throw notFound;
    }
    // Los pagos nuevos también bloquean esta misma fila de factura, así que mientras dure
    // esta transacción nadie puede registrar un pago que cambie esta suma.
    const appliedTotal = await sumAppliedPaymentsInTransaction(transaction, invoiceId);

    // --- 2. Reglas del servicio ---
    await checkLocked({ invoice, appliedTotal });

    // --- 3. Cambio de estado ---
    const isVoid = status === 'ANULADA';
    const upd = await transaction
      .request()
      .input('invoiceId', sql.Int, invoiceId)
      .input('status', sql.VarChar(15), status)
      .input('voidReason', sql.NVarChar(255), isVoid ? voidReason : null)
      .query(`
        UPDATE ${TABLE}
        SET Status = @status,
            Void_reason = CASE WHEN @status = 'ANULADA' THEN @voidReason ELSE Void_reason END
        OUTPUT INSERTED.*
        WHERE Invoice_id = @invoiceId
      `);
    const newRow = upd.recordset[0];

    // Bitácora: solo lo que cambió. Anular se registra como VOID; el resto como STATUS_CHANGE.
    const oldValue = { Status: invoice.Status };
    const newValue = { Status: newRow.Status };
    if (isVoid) {
      oldValue.Void_reason = invoice.Void_reason ?? null;
      newValue.Void_reason = newRow.Void_reason;
    }
    await auditRepo.insertInTransaction(transaction, {
      entityType: 'INVOICE',
      entityId: invoiceId,
      action: isVoid ? 'VOID' : 'STATUS_CHANGE',
      oldValue,
      newValue,
      userId,
      ipAddress,
    });

    await transaction.commit();
    return newRow;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

module.exports = {
  TODAY_CR_SQL,
  findById,
  listBalanceByEnterprise,
  findBalanceInTransaction,
  sumAppliedPaymentsInTransaction,
  createWithAudit,
  changeStatusWithAudit,
};
