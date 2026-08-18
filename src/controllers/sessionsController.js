// Controller para el endpoint de resultados de visita (Paso 6, guía "Fotos de Visita" v1.9,
// sección 8.3). Rutas asociadas: /api/sessions
//
// "session_id" en la guía es el mismo Visit_id devuelto al abrir la visita (Paso 0) — se
// nombra "sessions" en la URL porque así lo especifica la guía textualmente
// (GET /api/sessions/:id/results), aunque internamente todo se resuelve contra
// RETSC_EX_VISIT. No confundir con un recurso "session" distinto — no existe tal tabla.

const visitService         = require('../services/visitService');
const visitResultsService  = require('../services/visitResultsService');
const { ROLES, normalizeRole } = require('../config/roles');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[sessions]', err);
  return res.status(status).json({ success: false, message: err.message });
}

function parseId(value, label) {
  const id = parseInt(value, 10);
  if (isNaN(id)) throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  return id;
}

// GET /api/sessions/:id/results
// Scoping: ADMIN_DTC ve cualquier visita; los demás roles solo ven visitas de su propio
// enterprise (mismo criterio que GET /api/enterprises/:id — ver enterpriseService.js).
const getResults = async (req, res) => {
  try {
    const visitId = parseId(req.params.id, 'Visit ID (session_id)');

    const visit = await visitService.getVisit(visitId);
    const isAdminDtc = normalizeRole(req.user.roleName) === ROLES.ADMIN_DTC;
    if (!isAdminDtc && visit.enterpriseId !== req.user.enterpriseId) {
      return res.status(403).json({ success: false, message: 'No puedes ver los resultados de una visita de otro enterprise.' });
    }

    const results = await visitResultsService.getResults(visitId);
    return res.json({ success: true, ...results });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { getResults };
