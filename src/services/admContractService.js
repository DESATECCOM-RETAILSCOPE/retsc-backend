/**
 * admContractService.js — Reglas de negocio de los contratos del módulo administrativo.
 *
 * Para qué sirve: valida los datos, aplica las reglas de la especificación (sección 3.2
 *   y 8) y traduce los rechazos de la base a mensajes claros en español (422).
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos:
 *   // TODO: confirmar con María si el plazo de crédito de OC_FACTURA debe restringirse
 *   //       a 30, 60, 90 o 120 (valores usuales de la spec). Hoy se acepta 0 a 180.
 *
 * NOTA: las transiciones de estado (BORRADOR -> ACTIVO -> FINALIZADO, y FINALIZADO sin
 *   salida) son una decisión de implementación; la especificación solo dice que "para
 *   cambiar de plan se finaliza el actual y se crea otro". Confirmar con María.
 * NOTA: "solo un contrato ACTIVO por empresa" lo garantiza la base con un índice único
 *   filtrado. Aquí NO se consulta antes de escribir (evita carreras entre dos peticiones):
 *   se deja que la base decida y se traduce su error.
 * NOTA: guardia de facturas — un contrato que ya tiene facturas (cualquier estado, ANULADA
 *   incluida) NO puede cambiar de MONEDA, porque factura, OC y pago deben tener la misma
 *   moneda (spec, sección 8). El PLAZO (Credit_days) sí se puede cambiar: cada factura guarda
 *   su propia copia del plazo al registrarse (sección 8, "Plazo congelado"), así que cambiarlo
 *   no mueve facturas ya emitidas. El MÉTODO DE PAGO tampoco se bloquea: la spec no define
 *   qué pasa con él cuando ya hay facturas. Confirmar con María.
 */

const contractRepo = require('../repositories/admContractRepo');
const enterpriseRepo = require('../repositories/admEnterpriseRepo');
const { resolveEnterpriseId } = require('../utils/admScope');
const { isUniqueViolation, isForeignKeyViolation } = require('../utils/admSqlErrors');
const {
  svcError, fieldError, requiredString, optionalString, oneOf, money,
  intInRange, positiveInt, dateOnly, requiredBool,
} = require('../utils/admValidation');

// Valores permitidos (los mismos CHECK que tiene la base).
const STATUSES = ['BORRADOR', 'ACTIVO', 'FINALIZADO'];
const FREQUENCIES = ['MENSUAL', 'TRIMESTRAL', 'ANUAL'];
const CURRENCIES = ['CRC', 'USD'];
const PAYMENT_METHODS = ['PASARELA', 'OC_FACTURA'];

// A qué estados se puede pasar desde cada uno. FINALIZADO es definitivo.
const ALLOWED_TRANSITIONS = {
  BORRADOR: ['ACTIVO', 'FINALIZADO'],
  ACTIVO: ['FINALIZADO'],
  FINALIZADO: [],
};

// Una fecha de SQL (Date de JavaScript) o texto -> 'AAAA-MM-DD'. Se usa para mostrar y comparar.
function dateToString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

// Fecha y hora de SQL -> texto ISO (o null).
function dateTimeToString(value) {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

// Convierte una fila de la base (Pascal_Case) a camelCase, como pide CLAUDE.md.
// Los BIT se normalizan a 1/0.
function toDTO(row) {
  if (!row) return null;
  return {
    contractId: row.Contract_id,
    enterpriseId: row.Enterprise_id,
    planCode: row.Plan_code,
    status: row.Status,
    startDate: dateToString(row.Start_date),
    endDate: dateToString(row.End_date),
    billingFrequency: row.Billing_frequency,
    amountPerPeriod: Number(row.Amount_per_period),
    currency: String(row.Currency).trim(),
    paymentMethod: row.Payment_method,
    creditDays: row.Credit_days,
    requiresPo: row.Requires_po ? 1 : 0,
    issuerName: row.Issuer_name ?? null,
    createdAt: dateTimeToString(row.Created_at),
    createdUserId: row.Created_userid,
    updatedAt: dateTimeToString(row.Updated_at),
    updatedUserId: row.Updated_userid ?? null,
  };
}

// Reglas que cruzan varios campos (la base también las tiene; aquí se dan mensajes claros).
function checkCrossFields({ paymentMethod, creditDays, startDate, endDate }) {
  // Pago por pasarela = se paga al momento: no hay días de crédito.
  if (paymentMethod === 'PASARELA' && creditDays !== 0) {
    throw fieldError('creditDays', 'Con pago por PASARELA los días de crédito deben ser 0.');
  }
  // Las fechas se comparan como texto AAAA-MM-DD, que ordena igual que las fechas reales.
  if (endDate && endDate < startDate) {
    throw fieldError('endDate', 'La fecha de fin no puede ser anterior a la de inicio.');
  }
}

// Traduce errores de la base a errores de negocio. Si no reconoce el error, lo devuelve igual.
function mapDbError(err) {
  if (isUniqueViolation(err, 'UX_ADM_CONTRACT_ACTIVE_ENTERPRISE')) {
    return fieldError(
      'status',
      'La empresa ya tiene un contrato ACTIVO. Finalice el actual antes de activar otro.',
    );
  }
  if (isForeignKeyViolation(err)) {
    return fieldError('enterpriseId', 'La empresa o el usuario indicado no existe.');
  }
  return err;
}

// GET /api/adm/contract — contrato ACTIVO de la empresa (null si no tiene).
const getActive = async (user, enterpriseRaw) => {
  const enterpriseId = resolveEnterpriseId(user, enterpriseRaw);
  const row = await contractRepo.findActiveByEnterprise(enterpriseId);
  return toDTO(row);
};

// GET /api/adm/contracts — todos los contratos de la empresa (consola de DTC).
const list = async (user, enterpriseRaw) => {
  const enterpriseId = resolveEnterpriseId(user, enterpriseRaw);
  const rows = await contractRepo.listByEnterprise(enterpriseId);
  return rows.map(toDTO);
};

// POST /api/adm/contracts — crea un contrato. Solo DTC (lo exige la ruta).
// La empresa viene en el cuerpo porque DTC trabaja sobre cualquiera.
const create = async (user, body, ipAddress) => {
  const input = body || {};

  const enterpriseId = positiveInt(input.enterpriseId, 'enterpriseId', 'La empresa');
  // Comprobación previa solo para dar un mensaje claro; la llave foránea sigue siendo la defensa real.
  if (!(await enterpriseRepo.exists(enterpriseId))) {
    throw fieldError('enterpriseId', 'La empresa indicada no existe.');
  }

  const rec = {
    enterpriseId,
    planCode: requiredString(input.planCode, 'planCode', 'El plan', 30),
    // Por defecto BORRADOR: no empieza a facturar hasta que alguien lo active a propósito.
    status: input.status == null ? 'BORRADOR' : oneOf(input.status, 'status', 'El estado', STATUSES),
    startDate: dateOnly(input.startDate, 'startDate', 'La fecha de inicio', { required: true }),
    endDate: dateOnly(input.endDate, 'endDate', 'La fecha de fin', { required: false }),
    billingFrequency: oneOf(input.billingFrequency, 'billingFrequency', 'La frecuencia', FREQUENCIES),
    amountPerPeriod: money(input.amountPerPeriod, 'amountPerPeriod', 'El monto por periodo'),
    currency: oneOf(input.currency, 'currency', 'La moneda', CURRENCIES),
    paymentMethod: oneOf(input.paymentMethod, 'paymentMethod', 'El método de pago', PAYMENT_METHODS),
    creditDays: intInRange(input.creditDays, 'creditDays', 'Los días de crédito', 0, 180),
    requiresPo: requiredBool(input.requiresPo, 'requiresPo', 'Exigir orden de compra'),
    issuerName: optionalString(input.issuerName, 'issuerName', 'El emisor de la factura', 150),
  };

  // Un contrato nuevo no puede nacer FINALIZADO.
  if (rec.status === 'FINALIZADO') {
    throw fieldError('status', 'Un contrato nuevo debe crearse en BORRADOR o ACTIVO.');
  }
  checkCrossFields(rec);

  try {
    const row = await contractRepo.createWithAudit(rec, { userId: user.userId, ipAddress });
    return toDTO(row);
  } catch (err) {
    throw mapDbError(err);
  }
};

// Normaliza el valor actual de una columna para compararlo con el nuevo y saber si cambió.
function normalizeForCompare(column, value) {
  if (column === 'Start_date' || column === 'End_date') return dateToString(value);
  if (column === 'Amount_per_period') return Number(value);
  if (column === 'Requires_po') return value ? 1 : 0;
  if (column === 'Currency') return String(value).trim();
  return value ?? null;
}

// PUT /api/adm/contracts/:id — edita campos de un contrato. Solo DTC.
// Solo se cambian los campos que vienen en el cuerpo (edición parcial).
const update = async (user, idRaw, body, ipAddress) => {
  const contractId = positiveInt(idRaw, 'id', 'El contrato');
  const input = body || {};

  const current = await contractRepo.findById(contractId);
  if (!current) throw svcError('Contrato no encontrado.', 404);
  if (current.Status === 'FINALIZADO') {
    throw svcError('Un contrato FINALIZADO no se puede editar.', 422, { field: 'status' });
  }

  // Valida solo lo que llegó y lo guarda con el NOMBRE DE COLUMNA de la base.
  const next = {};
  if ('planCode' in input) next.Plan_code = requiredString(input.planCode, 'planCode', 'El plan', 30);
  if ('startDate' in input) next.Start_date = dateOnly(input.startDate, 'startDate', 'La fecha de inicio', { required: true });
  if ('endDate' in input) next.End_date = dateOnly(input.endDate, 'endDate', 'La fecha de fin', { required: false });
  if ('billingFrequency' in input) next.Billing_frequency = oneOf(input.billingFrequency, 'billingFrequency', 'La frecuencia', FREQUENCIES);
  if ('amountPerPeriod' in input) next.Amount_per_period = money(input.amountPerPeriod, 'amountPerPeriod', 'El monto por periodo');
  if ('currency' in input) next.Currency = oneOf(input.currency, 'currency', 'La moneda', CURRENCIES);
  if ('paymentMethod' in input) next.Payment_method = oneOf(input.paymentMethod, 'paymentMethod', 'El método de pago', PAYMENT_METHODS);
  if ('creditDays' in input) next.Credit_days = intInRange(input.creditDays, 'creditDays', 'Los días de crédito', 0, 180);
  if ('requiresPo' in input) next.Requires_po = requiredBool(input.requiresPo, 'requiresPo', 'Exigir orden de compra');
  if ('issuerName' in input) next.Issuer_name = optionalString(input.issuerName, 'issuerName', 'El emisor de la factura', 150);

  if ('status' in input) {
    const status = oneOf(input.status, 'status', 'El estado', STATUSES);
    // Solo cuenta como cambio si es distinto del actual; si es igual, se ignora.
    if (status !== current.Status) {
      if (!ALLOWED_TRANSITIONS[current.Status].includes(status)) {
        throw fieldError('status', `No se puede pasar un contrato de ${current.Status} a ${status}.`);
      }
      next.Status = status;
    }
  }

  // Reglas entre campos, sobre el resultado final (lo nuevo + lo que ya tenía).
  checkCrossFields({
    paymentMethod: next.Payment_method ?? current.Payment_method,
    creditDays: next.Credit_days ?? current.Credit_days,
    startDate: next.Start_date ?? dateToString(current.Start_date),
    endDate: 'End_date' in next ? next.End_date : dateToString(current.End_date),
  });

  // Quita lo que no cambió, para no escribir ni ensuciar la bitácora con valores iguales.
  const changes = {};
  for (const [column, value] of Object.entries(next)) {
    if (normalizeForCompare(column, current[column]) !== normalizeForCompare(column, value)) {
      changes[column] = value;
    }
  }
  if (Object.keys(changes).length === 0) return toDTO(current);

  // Guardia de facturas: si la moneda realmente cambia y el contrato ya tiene facturas, se
  // rechaza (ver NOTA del encabezado). Solo se consulta cuando hace falta.
  // OPTIMIZAR: la cuenta se hace antes de la transacción de edición; una factura registrada
  //   justo entre la cuenta y el UPDATE no la detectaría. El riesgo es mínimo (lo hacen solo
  //   usuarios DTC) y la factura igual exige la moneda del contrato al registrarse.
  if ('Currency' in changes && (await contractRepo.countInvoices(contractId)) > 0) {
    throw fieldError(
      'currency',
      'No se puede cambiar la moneda: el contrato ya tiene facturas registradas. Finalice este contrato y cree uno nuevo con la otra moneda.',
    );
  }

  try {
    const row = await contractRepo.updateWithAudit(contractId, changes, { userId: user.userId, ipAddress });
    return toDTO(row);
  } catch (err) {
    throw mapDbError(err);
  }
};

module.exports = { getActive, list, create, update };
