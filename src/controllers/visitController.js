// Controller para RETSC_EX_VISIT — Paso 0 de la guía "Fotos de Visita" v1.9.
// Rutas asociadas: /api/visits
//
// enterpriseId sale siempre de req.user.enterpriseId (JWT) — ver visitService.js.

const visitService = require('../services/visitService');
const { ROLES, normalizeRole } = require('../config/roles');

function handleError(res, err) {
  const status    = err.statusCode || 500;
  const errorCode = err.errorCode  || undefined;
  if (status === 500) console.error('[visit]', err);
  return res.status(status).json({
    success: false,
    ...(errorCode && { errorCode }),
    message: err.message,
  });
}

function parseId(value, label) {
  const id = parseInt(value, 10);
  if (isNaN(id)) throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  return id;
}

// POST /api/visits — abre una visita (Paso 0: "el auditor/gerente abre la visita en el
// mobile, selecciona PDV"). Body: { retailerId, latitude?, longitude? }.
const open = async (req, res) => {
  try {
    const { retailerId, latitude, longitude } = req.body;
    const visit = await visitService.openVisit({
      userId:       req.user.userId,
      enterpriseId: req.user.enterpriseId,
      retailerId,
      latitude,
      longitude,
    });
    return res.status(201).json({ success: true, visit });
  } catch (err) {
    return handleError(res, err);
  }
};

// PATCH /api/visits/:id/close — cierra la visita (guía, callout "Cerrar la visita": "el
// momento natural para disparar cualquier procesamiento pendiente de esa visita").
const close = async (req, res) => {
  try {
    const visitId = parseId(req.params.id, 'Visit ID');
    const isAdmin = [ROLES.ADMIN, ROLES.ADMIN_DTC].includes(normalizeRole(req.user.roleName));
    const visit = await visitService.closeVisit(visitId, { userId: req.user.userId, isAdmin });
    return res.json({ success: true, visit });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/visits/:id — detalle de una visita (útil para que el mobile confirme estado).
const getOne = async (req, res) => {
  try {
    const visitId = parseId(req.params.id, 'Visit ID');
    const visit = await visitService.getVisit(visitId);
    return res.json({ success: true, visit });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { open, close, getOne };
