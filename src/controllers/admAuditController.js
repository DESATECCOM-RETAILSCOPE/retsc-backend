/**
 * admAuditController.js — Capa HTTP de la consulta de bitácora (/api/adm/audit).
 *
 * Para qué sirve: toma los filtros de la petición, llama al servicio y arma la respuesta
 *   { success, entries, nextBeforeId }. No tiene lógica de negocio.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 */

const service = require('../services/admAuditService');

// Convierte un error del servicio en respuesta HTTP. Mismo patrón que admContractController.
function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[adm/audit]', err);
  // err.payload trae datos extra, por ejemplo { field } para marcar el campo en pantalla.
  return res.status(status).json({ success: false, message: err.message, ...(err.payload ?? {}) });
}

// GET /api/adm/audit — bitácora con filtros y paginación. Solo DTC.
// nextBeforeId: valor para ?beforeId= de la página siguiente (null si no hay más).
const listAudit = async (req, res) => {
  try {
    const { entries, nextBeforeId } = await service.list(req.query);
    return res.json({ success: true, entries, nextBeforeId });
  } catch (err) { return handleError(res, err); }
};

module.exports = { listAudit };
