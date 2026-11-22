/**
 * admBillingProfileService.js — Reglas de los datos de facturación de una empresa.
 *
 * Para qué sirve: valida y guarda razón social, identificación fiscal, correo y dirección
 *   de facturación. Hay UNA fila por empresa; guardar la crea o la actualiza.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos:
 *   // TODO: confirmar con María si estos datos deben partir de los que ya tiene la tabla
 *   //       de empresas (Fiscal_id, Invoice_mail, Address) en lugar de capturarse aparte.
 *   //       Hoy son independientes, como define la especificación.
 *   // TODO: validar el formato de la identificación fiscal costarricense si se requiere.
 *
 * NOTA: el correo se valida con una expresión sencilla (algo@dominio.ext). No se
 *   reutiliza la de userService porque ese archivo no la exporta.
 */

const billingRepo = require('../repositories/admBillingProfileRepo');
const enterpriseRepo = require('../repositories/admEnterpriseRepo');
const { resolveEnterpriseId } = require('../utils/admScope');
const { isForeignKeyViolation } = require('../utils/admSqlErrors');
const { fieldError, requiredString, optionalString } = require('../utils/admValidation');

// Forma mínima de un correo: algo@algo.algo, sin espacios.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fila de la base (Pascal_Case) -> camelCase.
function toDTO(row) {
  if (!row) return null;
  return {
    enterpriseId: row.Enterprise_id,
    legalName: row.Legal_name,
    taxId: row.Tax_id,
    billingEmail: row.Billing_email,
    billingAddress: row.Billing_address ?? null,
    country: String(row.Country).trim(),
    updatedAt: row.Updated_at instanceof Date ? row.Updated_at.toISOString() : (row.Updated_at ?? null),
    updatedUserId: row.Updated_userid,
  };
}

// GET /api/adm/billing-profile — datos de facturación de la empresa (null si aún no hay).
const get = async (user, enterpriseRaw) => {
  const enterpriseId = resolveEnterpriseId(user, enterpriseRaw);
  const row = await billingRepo.findByEnterprise(enterpriseId);
  return toDTO(row);
};

// PUT /api/adm/billing-profile — crea o actualiza los datos. Solo DTC (lo exige la ruta).
// Devuelve { billingProfile, created }.
const save = async (user, enterpriseRaw, body, ipAddress) => {
  const enterpriseId = resolveEnterpriseId(user, enterpriseRaw);
  const input = body || {};

  if (!(await enterpriseRepo.exists(enterpriseId))) {
    throw fieldError('enterpriseId', 'La empresa indicada no existe.');
  }

  const rec = {
    enterpriseId,
    legalName: requiredString(input.legalName, 'legalName', 'La razón social', 150),
    taxId: requiredString(input.taxId, 'taxId', 'La identificación fiscal', 30),
    billingEmail: requiredString(input.billingEmail, 'billingEmail', 'El correo de facturación', 150),
    billingAddress: optionalString(input.billingAddress, 'billingAddress', 'La dirección', 255),
    // País por defecto: Costa Rica. Son 2 letras (código ISO) y se guardan en mayúsculas.
    country: (input.country == null || input.country === '') ? 'CR' : String(input.country).trim().toUpperCase(),
  };
  if (!EMAIL_REGEX.test(rec.billingEmail)) {
    throw fieldError('billingEmail', 'El correo de facturación no tiene un formato válido.');
  }
  if (!/^[A-Z]{2}$/.test(rec.country)) {
    throw fieldError('country', 'El país debe ser un código de 2 letras (por ejemplo CR).');
  }

  // Si ya existen datos idénticos, no se escribe nada (ni se ensucia la bitácora).
  const existing = await billingRepo.findByEnterprise(enterpriseId);
  if (
    existing &&
    existing.Legal_name === rec.legalName &&
    existing.Tax_id === rec.taxId &&
    existing.Billing_email === rec.billingEmail &&
    (existing.Billing_address ?? null) === rec.billingAddress &&
    String(existing.Country).trim() === rec.country
  ) {
    return { billingProfile: toDTO(existing), created: false };
  }

  try {
    const { row, created } = await billingRepo.upsertWithAudit(rec, { userId: user.userId, ipAddress });
    return { billingProfile: toDTO(row), created };
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw fieldError('enterpriseId', 'La empresa o el usuario indicado no existe.');
    }
    throw err;
  }
};

module.exports = { get, save };
