/**
 * admNoteService.js — Notas de seguimiento de cobro de una factura.
 *
 * Para qué sirve: valida y guarda las notas que deja DTC sobre una factura (qué se habló y
 *   cuándo volver a contactar) y las lista de la más reciente a la más antigua.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos:
 *   // TODO: preguntar a María si las notas deben auditarse. Hoy no se puede: la bitácora
 *   //       no acepta la entidad NOTE (ver admNoteRepo.js).
 *   // TODO: confirmar con María si Next_contact_date puede ser una fecha pasada. Hoy se acepta
 *   //       (sirve para registrar un seguimiento ya vencido).
 *
 * NOTA: se permiten notas también en facturas ANULADA o ya pagadas (la spec no lo restringe;
 *   puede servir para dejar constancia). Confirmar con María.
 */

const noteRepo = require('../repositories/admNoteRepo');
const invoiceRepo = require('../repositories/admInvoiceRepo');
const { isForeignKeyViolation } = require('../utils/admSqlErrors');
const { svcError, requiredString, positiveInt, dateOnly } = require('../utils/admValidation');

// Una fecha de SQL (Date de JavaScript) o texto -> 'AAAA-MM-DD'.
function dateToString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

// Fila de RETSC_ADM_COLLECTION_NOTE (Pascal_Case) -> camelCase.
function toDTO(row) {
  if (!row) return null;
  return {
    noteId: row.Note_id,
    invoiceId: row.Invoice_id,
    note: row.Note,
    nextContactDate: dateToString(row.Next_contact_date),
    createdUserId: row.Created_userid,
    createdAt: row.Created_at instanceof Date ? row.Created_at.toISOString() : (row.Created_at ?? null),
  };
}

// Comprueba que la factura existe (tabla, no vista: incluye ANULADA). 404 si no.
async function assertInvoiceExists(invoiceId) {
  const invoice = await invoiceRepo.findById(invoiceId);
  if (!invoice) throw svcError('Factura no encontrada.', 404);
}

// GET /api/adm/invoices/:id/notes — notas de una factura, más recientes primero. Solo DTC.
const listByInvoice = async (invoiceIdRaw) => {
  const invoiceId = positiveInt(invoiceIdRaw, 'id', 'La factura');
  await assertInvoiceExists(invoiceId);
  const rows = await noteRepo.listByInvoice(invoiceId);
  return rows.map(toDTO);
};

// POST /api/adm/invoices/:id/notes — agrega una nota a una factura. Solo DTC.
const create = async (user, invoiceIdRaw, body) => {
  const invoiceId = positiveInt(invoiceIdRaw, 'id', 'La factura');
  const input = body || {};
  // Se valida el cuerpo antes de ir a la base, para responder el 422 sin consultas.
  const note = requiredString(input.note, 'note', 'La nota', 500);
  const nextContactDate = dateOnly(input.nextContactDate, 'nextContactDate', 'La fecha de próximo contacto', { required: false });

  await assertInvoiceExists(invoiceId);

  try {
    const row = await noteRepo.create({ invoiceId, note, nextContactDate, userId: user.userId });
    return toDTO(row);
  } catch (err) {
    // Si la factura desapareció entre la comprobación y el INSERT (no debería: no se borran),
    // la llave foránea lo rechaza; se responde igual que si no existiera.
    if (isForeignKeyViolation(err)) throw svcError('Factura no encontrada.', 404);
    throw err;
  }
};

module.exports = { listByInvoice, create };
