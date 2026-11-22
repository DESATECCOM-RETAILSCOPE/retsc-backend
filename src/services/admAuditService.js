/**
 * admAuditService.js — Consulta de la bitácora del módulo administrativo (solo DTC).
 *
 * Para qué sirve: valida los filtros de GET /api/adm/audit, pide las filas al repositorio y
 *   las devuelve en camelCase con los datos personales ENMASCARADOS.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 *
 * NOTA: leer la bitácora NO se audita (no hay acción para eso y no lo pide la spec).
 * NOTA: Old_value / New_value guardan filas completas en JSON (por ejemplo, el alta de datos
 *   de facturación). Antes de responder se reemplazan por "***" los valores de las claves
 *   Billing_email, Tax_id, Billing_address y Legal_name, a cualquier nivel del JSON (spec,
 *   sección 9: datos fiscales y correo no se muestran en listas). La tabla no se toca.
 * NOTA: las claves se comparan sin distinguir mayúsculas ni guiones bajos, así se enmascaran
 *   también si algún día se guardan en camelCase (billingEmail, taxId...).
 */

const auditQueryRepo = require('../repositories/admAuditQueryRepo');
const { fieldError, oneOf, optionalPositiveInt, dateOnly } = require('../utils/admValidation');

// Valores válidos (los mismos CHECK que tiene la tabla RETSC_ADM_AUDIT_LOG).
const ENTITY_TYPES = ['CONTRACT', 'PO', 'INVOICE', 'PAYMENT', 'DOCUMENT', 'BILLING_PROFILE'];
// NOTA: ?action= se valida contra las acciones de la spec (sección 3.8); otro valor -> 422.
const ACTIONS = ['CREATE', 'UPDATE', 'STATUS_CHANGE', 'VOID', 'DOWNLOAD'];

// Tamaño de página: por defecto 50, máximo 200.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Claves con datos personales, normalizadas (minúsculas y sin guiones bajos).
const SENSITIVE_KEYS = new Set(['billingemail', 'taxid', 'billingaddress', 'legalname']);
const MASK = '***';
const UNREADABLE = '[no se pudo leer]';

const normalizeKey = (key) => String(key).toLowerCase().replace(/_/g, '');

// Recorre un valor JSON (objetos y arreglos, a cualquier profundidad) y devuelve una copia
// con los valores de las claves sensibles reemplazados por "***".
function maskSensitive(value) {
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(normalizeKey(key)) ? MASK : maskSensitive(inner);
    }
    return out;
  }
  return value;
}

// Texto JSON de la base -> objeto enmascarado. NULL se queda null; un texto que no es JSON
// válido se devuelve como "[no se pudo leer]" (nunca el texto crudo, que podría traer datos).
function parseAndMask(text) {
  if (text === null || text === undefined) return null;
  try {
    return maskSensitive(JSON.parse(text));
  } catch {
    return UNREADABLE;
  }
}

// Fila de la bitácora (+ User_name) -> camelCase. Audit_id es bigint: mssql puede devolverlo
// como texto, por eso se convierte a número.
function toDTO(row) {
  return {
    auditId: Number(row.Audit_id),
    entityType: row.Entity_type,
    entityId: row.Entity_id,
    action: row.Action,
    oldValue: parseAndMask(row.Old_value),
    newValue: parseAndMask(row.New_value),
    userId: row.User_id,
    userName: row.User_name ?? null,
    createdAt: row.Created_at instanceof Date ? row.Created_at.toISOString() : (row.Created_at ?? null),
    ipAddress: row.Ip_address ?? null,
  };
}

// GET /api/adm/audit — bitácora con filtros y paginación hacia atrás.
// Devuelve { entries, nextBeforeId }.
const list = async (query) => {
  const q = query || {};
  const present = (v) => v !== undefined && v !== null && v !== '';

  const filters = {
    entityType: present(q.entityType) ? oneOf(q.entityType, 'entityType', 'La entidad', ENTITY_TYPES) : null,
    entityId: optionalPositiveInt(q.entityId, 'entityId', 'El id de la entidad'),
    action: present(q.action) ? oneOf(q.action, 'action', 'La acción', ACTIONS) : null,
    userId: optionalPositiveInt(q.userId, 'userId', 'El usuario'),
    from: dateOnly(q.from, 'from', 'La fecha desde', { required: false }),
    to: dateOnly(q.to, 'to', 'La fecha hasta', { required: false }),
    beforeId: optionalPositiveInt(q.beforeId, 'beforeId', 'El cursor de página'),
    limit: DEFAULT_LIMIT,
  };

  // NOTA: suposición — "desde" posterior a "hasta" es un error del usuario (422), no una lista vacía.
  if (filters.from && filters.to && filters.from > filters.to) {
    throw fieldError('to', 'La fecha hasta no puede ser anterior a la fecha desde.');
  }

  if (present(q.limit)) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n <= 0) throw fieldError('limit', 'El límite debe ser un número entero mayor que 0.');
    // NOTA: suposición — un límite mayor al máximo se recorta a 200 en lugar de rechazarse.
    filters.limit = Math.min(n, MAX_LIMIT);
  }

  const entries = (await auditQueryRepo.list(filters)).map(toDTO);
  // Si vino una página llena, puede haber más: el cursor de la siguiente es el último id.
  // NOTA: nextBeforeId es un dato extra (no pedido) para que la pantalla pagine sin calcularlo.
  const nextBeforeId = entries.length === filters.limit ? entries[entries.length - 1].auditId : null;
  return { entries, nextBeforeId };
};

module.exports = {
  list,
  // Expuestos solo para las pruebas.
  _maskSensitive: maskSensitive,
  _parseAndMask: parseAndMask,
  MAX_LIMIT,
};
