/**
 * admPaymentService.js — Reglas de negocio de los pagos de facturas del módulo administrativo.
 *
 * Para qué sirve: valida y registra pagos manuales (transferencia, tarjeta, SINPE, otro),
 *   los anula con motivo y los lista. Aplica las reglas de la especificación (secciones 3.5
 *   y 8): la moneda del pago es la de la factura, y la suma de pagos APLICADO no puede
 *   superar el total de la factura.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos:
 *   // TODO: comprobante de pago (archivo) cuando exista el servicio de documentos.
 *   // TODO: confirmar con María si un pago puede tener fecha futura o anterior a la emisión
 *   //       de la factura. Hoy no se restringe.
 *
 * NOTA: los montos se comparan en CÉNTIMOS enteros, igual que en admInvoiceService.
 * NOTA: el estado de pago (PENDIENTE, PARCIAL, PAGADA) NO se guarda: lo calcula la vista
 *   RETSC_ADM_V_INVOICE_BALANCE. Este servicio solo devuelve lo que la vista dice.
 */

const paymentRepo = require('../repositories/admPaymentRepo');
const invoiceRepo = require('../repositories/admInvoiceRepo');
const { getSqlErrorNumber, isForeignKeyViolation } = require('../utils/admSqlErrors');
const {
  svcError, fieldError, requiredString, optionalString, oneOf, money, positiveInt, dateOnly,
} = require('../utils/admValidation');

// Valores permitidos (los mismos CHECK que tiene la base).
const CURRENCIES = ['CRC', 'USD'];
const METHODS = ['TRANSFERENCIA', 'TARJETA', 'SINPE', 'OTRO'];

// Monto -> céntimos enteros, para comparar sin errores de redondeo.
const toCents = (value) => Math.round(Number(value) * 100);
// Céntimos -> texto con 2 decimales, para los mensajes.
const formatCents = (cents) => (cents / 100).toFixed(2);

// Una fecha de SQL (Date de JavaScript) o texto -> 'AAAA-MM-DD'.
function dateToString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

// Fecha y hora de SQL -> texto ISO (o null).
function dateTimeToString(value) {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

// Fila de RETSC_ADM_PAYMENT (Pascal_Case) -> camelCase.
function toDTO(row) {
  if (!row) return null;
  return {
    paymentId: row.Payment_id,
    invoiceId: row.Invoice_id,
    paymentDate: dateToString(row.Payment_date),
    amount: Number(row.Amount),
    currency: String(row.Currency).trim(),
    method: row.Method,
    reference: row.Reference ?? null,
    bank: row.Bank ?? null,
    source: row.Source,
    status: row.Status,
    voidReason: row.Void_reason ?? null,
    recordedUserId: row.Recorded_userid,
    recordedAt: dateTimeToString(row.Recorded_at),
  };
}

// Saldo de la factura (fila de RETSC_ADM_V_INVOICE_BALANCE) -> lo que necesita la pantalla.
// Devuelve null si la vista no trae la factura (pasa solo con facturas ANULADA).
function toBalanceDTO(row) {
  if (!row) return null;
  return {
    invoiceId: row.Invoice_id,
    totalAmount: Number(row.Total_amount),
    paidTotal: Number(row.Paid_total),
    balance: Number(row.Balance),
    paymentStatus: row.Payment_status,
  };
}

// Traduce errores de la base a errores de negocio. Si no reconoce el error, lo devuelve igual.
function mapDbError(err) {
  const message = String(err?.message || '');
  if (getSqlErrorNumber(err) === 547 && message.includes('CK_ADM_PAYMENT_AMOUNT')) {
    return fieldError('amount', 'El monto del pago debe ser mayor que 0.');
  }
  if (getSqlErrorNumber(err) === 547 && message.includes('CK_ADM_PAYMENT_VOID')) {
    return fieldError('reason', 'Para anular un pago indique el motivo.');
  }
  if (isForeignKeyViolation(err)) {
    return fieldError('invoiceId', 'La factura o el usuario indicado no existe.');
  }
  return err;
}

// Reglas de un pago nuevo, evaluadas con la factura BLOQUEADA y la suma de pagos al día.
// Se exporta (con _) solo para las pruebas.
function checkNewPayment({ invoice, appliedTotal }, rec) {
  if (invoice.Status === 'ANULADA') {
    throw fieldError('status', 'No se pueden registrar pagos en una factura ANULADA.');
  }
  const invoiceCurrency = String(invoice.Currency).trim();
  if (rec.currency !== invoiceCurrency) {
    throw fieldError('currency', `La moneda del pago debe ser la de la factura (${invoiceCurrency}).`);
  }
  // Saldo pendiente = total - pagos APLICADO. El pago no puede superarlo.
  const pending = toCents(invoice.Total_amount) - toCents(appliedTotal);
  if (toCents(rec.amount) > pending) {
    throw fieldError(
      'amount',
      `El pago supera el saldo pendiente de la factura (${formatCents(pending)} ${invoiceCurrency}).`,
    );
  }
}

// POST /api/adm/invoices/:id/payments — registra un pago manual. Solo DTC.
// Devuelve { payment, invoiceBalance }.
const create = async (user, invoiceIdRaw, body, ipAddress) => {
  const invoiceId = positiveInt(invoiceIdRaw, 'id', 'La factura');
  const input = body || {};

  const amount = money(input.amount, 'amount', 'El monto');
  // money() acepta 0; un pago debe ser mayor que 0 (CHECK CK_ADM_PAYMENT_AMOUNT).
  if (amount <= 0) throw fieldError('amount', 'El monto del pago debe ser mayor que 0.');

  const rec = {
    paymentDate: dateOnly(input.paymentDate, 'paymentDate', 'La fecha del pago', { required: true }),
    amount,
    currency: oneOf(input.currency, 'currency', 'La moneda', CURRENCIES),
    method: oneOf(input.method, 'method', 'El método de pago', METHODS),
    reference: optionalString(input.reference, 'reference', 'La referencia', 100),
    bank: optionalString(input.bank, 'bank', 'El banco', 80),
  };

  try {
    const { row, balance } = await paymentRepo.createWithAudit(
      invoiceId,
      rec,
      { userId: user.userId, ipAddress },
      (locked) => checkNewPayment(locked, rec),
    );
    return { payment: toDTO(row), invoiceBalance: toBalanceDTO(balance) };
  } catch (err) {
    throw mapDbError(err);
  }
};

// POST /api/adm/payments/:id/void — anula un pago con motivo. Solo DTC.
// Devuelve { payment, invoiceBalance }.
const voidPayment = async (user, paymentIdRaw, body, ipAddress) => {
  const paymentId = positiveInt(paymentIdRaw, 'id', 'El pago');
  const reason = requiredString((body || {}).reason, 'reason', 'El motivo de anulación', 255);

  // Solo se anula un pago APLICADO (uno ANULADO ya no cambia).
  const checkLocked = ({ payment }) => {
    if (payment.Status !== 'APLICADO') {
      throw fieldError('status', `Solo se puede anular un pago APLICADO (este está ${payment.Status}).`);
    }
  };

  try {
    const { row, balance } = await paymentRepo.voidWithAudit(
      paymentId,
      reason,
      { userId: user.userId, ipAddress },
      checkLocked,
    );
    return { payment: toDTO(row), invoiceBalance: toBalanceDTO(balance) };
  } catch (err) {
    throw mapDbError(err);
  }
};

// GET /api/adm/invoices/:id/payments — pagos de una factura. Solo DTC.
// NOTA: endpoint extra, no está en la tabla de la spec (sección 6); la pantalla lo necesita.
const listByInvoice = async (invoiceIdRaw) => {
  const invoiceId = positiveInt(invoiceIdRaw, 'id', 'La factura');
  // 404 claro si la factura no existe (en lugar de una lista vacía engañosa).
  const invoice = await invoiceRepo.findById(invoiceId);
  if (!invoice) throw svcError('Factura no encontrada.', 404);
  const rows = await paymentRepo.listByInvoice(invoiceId);
  return rows.map(toDTO);
};

module.exports = {
  create,
  voidPayment,
  listByInvoice,
  // Expuesto solo para las pruebas.
  _checkNewPayment: checkNewPayment,
};
