/**
 * admNoteController.js — Capa HTTP de las notas de seguimiento de cobro (/api/adm/invoices/:id/notes).
 *
 * Para qué sirve: toma lo que llega en la petición (token, parámetros, cuerpo), llama al
 *   servicio y arma la respuesta { success, ... }. No tiene lógica de negocio.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 */

const service = require('../services/admNoteService');

// Convierte un error del servicio en respuesta HTTP. Mismo patrón que admContractController.
function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[adm/note]', err);
  // err.payload trae datos extra, por ejemplo { field } para marcar el campo en pantalla.
  return res.status(status).json({ success: false, message: err.message, ...(err.payload ?? {}) });
}

// GET /api/adm/invoices/:id/notes — notas de una factura, más recientes primero. Solo DTC.
const listNotes = async (req, res) => {
  try {
    const notes = await service.listByInvoice(req.params.id);
    return res.json({ success: true, notes });
  } catch (err) { return handleError(res, err); }
};

// POST /api/adm/invoices/:id/notes — agrega una nota de seguimiento. Solo DTC.
const createNote = async (req, res) => {
  try {
    const note = await service.create(req.user, req.params.id, req.body);
    return res.status(201).json({ success: true, note });
  } catch (err) { return handleError(res, err); }
};

module.exports = { listNotes, createNote };
