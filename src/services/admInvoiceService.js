/**
 * admInvoiceService.js — Reglas de negocio de las facturas del módulo administrativo.
 *
 * Para qué sirve: valida los datos de una factura, aplica las reglas de la especificación
 *   (secciones 3.4 y 8: moneda, total, OC obligatoria, saldo de la OC, plazo congelado,
 *   transiciones de estado) y traduce los rechazos de la base a mensajes claros (422).
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos:
 *   // TODO: adjuntos PDF/XML de la factura cuando exista el servicio de documentos.
 *   // TODO: paginación de GET /api/adm/invoices.
 *   // TODO: confirmar con María si Received_date puede ser anterior a Issue_date o si una
 *   //       factura puede tener fecha de emisión futura. Hoy no se restringe.
 *
 * NOTA: los montos se comparan en CÉNTIMOS enteros (Math.round(x * 100)) para evitar los
 *   errores de redondeo de los decimales en JavaScript (0.1 + 0.2 !== 0.3).
 * NOTA: las reglas que dependen del saldo de la OC o de la suma de pagos se evalúan dentro
 *   de la transacción del repositorio (función checkLocked), con las filas bloqueadas, para
 *   que dos peticiones simultáneas no puedan saltarse el límite.
 */

const invoiceRepo = require('../repositories/admInvoiceRepo');
const contractRepo = require('../repositories/admContractRepo');
const { resolveEnterpriseId } = require('../utils/admScope');
const { getSqlErrorNumber, isUniqueViolation, isForeignKeyViolation } = require('../utils/admSqlErrors');
const {
  fieldError, requiredString, optionalString, oneOf, money,
  intInRange, positiveInt, optionalPositiveInt, dateOnly,
} = require('../utils/admValidation');

// Valores permitidos (los mismos CHECK que tiene la base).
const CURRENCIES = ['CRC', 'USD'];
// Estados a los que se puede pasar con POST /invoices/:id/status (REGISTRADA es solo el inicial).
const TARGET_STATUSES = ['ENVIADA', 'EN_DISPUTA', 'ANULADA'];
// Estados que se pueden filtrar en el listado: la vista excluye las ANULADA.
const LISTABLE_STATUSES = ['REGISTRADA', 'ENVIADA', 'EN_DISPUTA'];

// NOTA: la especificación no define las transiciones de estado de una factura. Suposición:
//   REGISTRADA -> ENVIADA | EN_DISPUTA | ANULADA
//   ENVIADA    -> EN_DISPUTA | ANULADA
//   EN_DISPUTA -> ENVIADA | ANULADA
//   ANULADA es definitiva (una factura corregida es un registro NUEVO, sección 8).
//   Pasar al mismo estado en el que ya está se rechaza como transición no permitida.
//   Confirmar con María.
const ALLOWED_TRANSITIONS = {
  REGISTRADA: ['ENVIADA', 'EN_DISPUTA', 'ANULADA'],
  ENVIADA: ['EN_DISPUTA', 'ANULADA'],
  EN_DISPUTA: ['ENVIADA', 'ANULADA'],
  ANULADA: [],
};

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

// Fila de RETSC_ADM_INVOICE (Pascal_Case) -> camelCase. Se usa en el alta y el cambio de estado.
function toDTO(row) {
  if (!row) return null;
  return {
    invoiceId: row.Invoice_id,
    enterpriseId: row.Enterprise_id,
    contractId: row.Contract_id,
    poId: row.PO_id ?? null,
    invoiceNumber: row.Invoice_number,
    invoiceKey: row.Invoice_key ?? null,
    issueDate: dateToString(row.Issue_date),
    receivedDate: dateToString(row.Received_date),
    creditDays: row.Credit_days,
    dueDate: dateToString(row.Due_date),
    subtotal: Number(row.Subtotal),
    taxAmount: Number(row.Tax_amount),
    totalAmount: Number(row.Total_amount),
    currency: String(row.Currency).trim(),
    status: row.Status,
    voidReason: row.Void_reason ?? null,
    periodFrom: dateToString(row.Period_from),
    periodTo: dateToString(row.Period_to),
    createdAt: dateTimeToString(row.Created_at),
    createdUserId: row.Created_userid,
  };
}

// Fila de la vista RETSC_ADM_V_INVOICE_BALANCE -> camelCase. Se usa en el listado.
// NOTA: además de las columnas pedidas se incluye enterpriseId (también es columna de la
//   vista); permite comprobar en las pruebas que un cliente solo recibe las suyas.
function toBalanceDTO(row) {
  if (!row) return null;
  return {
    invoiceId: row.Invoice_id,
    enterpriseId: row.Enterprise_id,
    contractId: row.Contract_id,
    poId: row.PO_id ?? null,
    invoiceNumber: row.Invoice_number,
    issueDate: dateToString(row.Issue_date),
    receivedDate: dateToString(row.Received_date),
    dueDate: dateToString(row.Due_date),
    currency: String(row.Currency).trim(),
    status: row.Status,
    totalAmount: Number(row.Total_amount),
    paidTotal: Number(row.Paid_total),
    balance: Number(row.Balance),
    paymentStatus: row.Payment_status,
    daysOverdue: row.Days_overdue == null ? null : Number(row.Days_overdue),
    agingBucket: row.Aging_bucket ?? null,
  };
}

// Traduce errores de la base a errores de negocio. Si no reconoce el error, lo devuelve igual.
function mapDbError(err) {
  if (isUniqueViolation(err, 'UX_ADM_INVOICE_NUMBER')) {
    return fieldError('invoiceNumber', 'Ya existe una factura con ese número en este contrato.');
  }
  // 547 sin FOREIGN KEY = una regla CHECK. Se reconocen las de factura por su nombre.
  const message = String(err?.message || '');
  if (getSqlErrorNumber(err) === 547 && message.includes('CK_ADM_INVOICE_TOTAL')) {
    return fieldError('totalAmount', 'El total debe ser igual al subtotal más el impuesto.');
  }
  if (getSqlErrorNumber(err) === 547 && message.includes('CK_ADM_INVOICE_VOID')) {
    return fieldError('reason', 'Para anular una factura indique el motivo.');
  }
  if (isForeignKeyViolation(err)) {
    return fieldError('contractId', 'El contrato, la orden de compra o el usuario indicado no existe.');
  }
  return err;
}

// Valida la orden de compra leída BAJO BLOQUEO contra la factura que se quiere registrar.
// Devuelve { closePo } = true si con esta factura la OC llega exactamente a su monto.
// Se exporta (con _) solo para las pruebas.
function checkPurchaseOrder({ po, poInvoicedTotal }, rec) {
  if (rec.poId == null) return { closePo: false };

  if (!po) throw fieldError('poId', 'La orden de compra indicada no existe.');
  // La OC debe ser de la misma empresa y del mismo contrato que la factura (sección 8).
  if (po.Enterprise_id !== rec.enterpriseId || po.Contract_id !== rec.contractId) {
    throw fieldError('poId', 'La orden de compra no pertenece a la empresa y contrato de la factura.');
  }
  if (po.Status !== 'VALIDADA') {
    throw fieldError('poId', `La orden de compra debe estar VALIDADA (está ${po.Status}).`);
  }
  // Moneda: factura, OC y contrato deben coincidir.
  if (String(po.Currency).trim() !== rec.currency) {
    throw fieldError('currency', `La moneda de la factura debe ser la de la orden de compra (${String(po.Currency).trim()}).`);
  }

  // Saldo de la OC: lo ya facturado (sin anuladas) + esta factura no puede superar el monto.
  const limit = toCents(po.Amount);
  const used = toCents(poInvoicedTotal);
  const after = used + toCents(rec.totalAmount);
  if (after > limit) {
    throw fieldError(
      'totalAmount',
      `La factura supera el saldo disponible de la orden de compra (disponible: ${formatCents(limit - used)} ${rec.currency}).`,
    );
  }
  // Si llega exactamente al monto, la OC se cierra en la misma transacción.
  return { closePo: after === limit };
}

// GET /api/adm/invoices — facturas con saldo de una empresa.
// Cliente: la suya (del token). DTC: ?enterpriseId= obligatorio.
const list = async (user, query) => {
  const q = query || {};
  const enterpriseId = resolveEnterpriseId(user, q.enterpriseId);

  const filters = {};
  if (q.status != null && q.status !== '') {
    filters.status = oneOf(q.status, 'status', 'El estado', LISTABLE_STATUSES);
  }
  if (q.currency != null && q.currency !== '') {
    filters.currency = oneOf(q.currency, 'currency', 'La moneda', CURRENCIES);
  }
  if (q.overdue != null && q.overdue !== '') {
    // Solo se aceptan 1 (solo vencidas) o 0 (sin filtro).
    if (q.overdue !== '1' && q.overdue !== '0') {
      throw fieldError('overdue', 'El filtro de vencidas debe ser 1 o 0.');
    }
    filters.overdue = q.overdue === '1';
  }
  if (q.dueWithinDays != null && q.dueWithinDays !== '') {
    // NOTA: el rango 0..366 es una suposición (la spec no lo define); la pantalla usa 7.
    filters.dueWithinDays = intInRange(q.dueWithinDays, 'dueWithinDays', 'Los días hasta el vencimiento', 0, 366);
  }

  const rows = await invoiceRepo.listBalanceByEnterprise(enterpriseId, filters);
  return rows.map(toBalanceDTO);
};

// POST /api/adm/invoices — registra una factura. Solo DTC (lo exige la ruta).
// Devuelve { invoice, poClosed }.
const create = async (user, body, ipAddress) => {
  const input = body || {};

  // --- Validación de formato de cada campo ---
  const contractId = positiveInt(input.contractId, 'contractId', 'El contrato');
  const poId = optionalPositiveInt(input.poId, 'poId', 'La orden de compra');
  const invoiceNumber = requiredString(input.invoiceNumber, 'invoiceNumber', 'El número de factura', 50);
  const invoiceKey = optionalString(input.invoiceKey, 'invoiceKey', 'La clave del comprobante', 60);
  const issueDate = dateOnly(input.issueDate, 'issueDate', 'La fecha de emisión', { required: true });
  const receivedDate = dateOnly(input.receivedDate, 'receivedDate', 'La fecha de recibido', { required: false });
  const periodFrom = dateOnly(input.periodFrom, 'periodFrom', 'El inicio del periodo', { required: false });
  const periodTo = dateOnly(input.periodTo, 'periodTo', 'El fin del periodo', { required: false });
  const subtotal = money(input.subtotal, 'subtotal', 'El subtotal');
  const taxAmount = money(input.taxAmount, 'taxAmount', 'El impuesto');
  const totalAmount = money(input.totalAmount, 'totalAmount', 'El total');
  const currency = oneOf(input.currency, 'currency', 'La moneda', CURRENCIES);

  // NOTA: suposición — el fin del periodo no puede ser anterior al inicio (la spec no lo dice).
  // Las fechas AAAA-MM-DD se comparan como texto, que ordena igual que las fechas reales.
  if (periodFrom && periodTo && periodTo < periodFrom) {
    throw fieldError('periodTo', 'El fin del periodo no puede ser anterior al inicio.');
  }

  // Total = Subtotal + Impuesto (la base tiene el mismo CHECK; aquí se da el mensaje claro).
  if (toCents(subtotal) + toCents(taxAmount) !== toCents(totalAmount)) {
    throw fieldError('totalAmount', 'El total debe ser igual al subtotal más el impuesto.');
  }

  // --- Contrato: de aquí salen la empresa, la moneda, el plazo y si exige OC ---
  const contract = await contractRepo.findById(contractId);
  if (!contract) throw fieldError('contractId', 'El contrato indicado no existe.');
  // NOTA: suposición — solo se registran facturas sobre contratos ACTIVO (la spec no lo dice).
  if (contract.Status !== 'ACTIVO') {
    throw fieldError('contractId', `Solo se registran facturas de contratos ACTIVO (este está ${contract.Status}).`);
  }
  const contractCurrency = String(contract.Currency).trim();
  if (currency !== contractCurrency) {
    throw fieldError('currency', `La moneda de la factura debe ser la del contrato (${contractCurrency}).`);
  }
  // OC obligatoria si el contrato la exige (Requires_po = 1).
  if (contract.Requires_po && poId == null) {
    throw fieldError('poId', 'Este contrato exige una orden de compra VALIDADA para registrar la factura.');
  }

  const rec = {
    // La empresa sale del CONTRATO leído de la base, nunca del cuerpo de la petición.
    enterpriseId: contract.Enterprise_id,
    contractId,
    poId,
    invoiceNumber,
    invoiceKey,
    issueDate,
    receivedDate,
    // Plazo congelado: se COPIA del contrato al registrar (sección 8).
    creditDays: contract.Credit_days,
    subtotal,
    taxAmount,
    totalAmount,
    currency,
    periodFrom,
    periodTo,
  };

  try {
    // NOTA: si viene una OC se valida aunque el contrato no la exija (suposición: una OC
    //   indicada siempre debe ser válida, de la misma empresa y contrato, y con saldo).
    const { row, poClosed } = await invoiceRepo.createWithAudit(
      rec,
      { userId: user.userId, ipAddress },
      (locked) => checkPurchaseOrder(locked, rec),
    );
    return { invoice: toDTO(row), poClosed };
  } catch (err) {
    throw mapDbError(err);
  }
};

// POST /api/adm/invoices/:id/status — cambia el estado de una factura. Solo DTC.
const changeStatus = async (user, idRaw, body, ipAddress) => {
  const invoiceId = positiveInt(idRaw, 'id', 'La factura');
  const input = body || {};
  const status = oneOf(input.status, 'status', 'El estado', TARGET_STATUSES);
  // Anular exige motivo (la base tiene el CHECK CK_ADM_INVOICE_VOID).
  const voidReason = status === 'ANULADA'
    ? requiredString(input.reason, 'reason', 'El motivo de anulación', 255)
    : null;

  // Reglas que se revisan con la factura bloqueada y la suma de pagos al día.
  const checkLocked = ({ invoice, appliedTotal }) => {
    const from = invoice.Status;
    if (!ALLOWED_TRANSITIONS[from]?.includes(status)) {
      throw fieldError('status', `No se puede pasar una factura de ${from} a ${status}.`);
    }
    // NOTA: suposición — una factura con pagos APLICADO no se anula: primero se anulan los pagos.
    if (status === 'ANULADA' && toCents(appliedTotal) > 0) {
      throw fieldError('status', 'La factura tiene pagos aplicados. Anule primero los pagos y luego la factura.');
    }
    // TODO: si la factura anulada estaba ligada a una OC CERRADA, decidir con María si la OC
    //       vuelve a VALIDADA (recupera saldo). Hoy la OC queda CERRADA.
  };

  try {
    const row = await invoiceRepo.changeStatusWithAudit(
      invoiceId,
      { status, voidReason },
      { userId: user.userId, ipAddress },
      checkLocked,
    );
    return toDTO(row);
  } catch (err) {
    throw mapDbError(err);
  }
};

module.exports = {
  list,
  create,
  changeStatus,
  // Expuestos solo para las pruebas.
  ALLOWED_TRANSITIONS,
  _checkPurchaseOrder: checkPurchaseOrder,
};
