// Controller de listado de modelos de detección (Issue 8.5 — reducido 2026-08-03).
// Rutas asociadas: /api/models
//
// RETIRADO por decisión de jefatura: canRetrain/retrain/complete/approve/reject/rollback —
// ver modelVersioningService.js para el detalle completo de qué se eliminó y qué se
// preservó para la pasada de cableado del flujo automático (spec v1.4).
//
// La autorización (Admin) se aplica en modelRoutes.js con requireRole; aquí se asume
// que req.user ya existe (authMiddleware).

const modelVersioningService = require('../services/modelVersioningService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[model]', err);
  return res.status(status).json({ success: false, message: err.message });
}

function parseId(value, label) {
  const id = parseInt(value, 10);
  if (isNaN(id)) throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  return id;
}

// GET /api/models  — listado global de modelos (todas las categorías/versiones)
// Alimenta el ítem "Modelos de detección" del menú ADMIN_DTC (F4).
const listAll = async (req, res) => {
  try {
    const models = await modelVersioningService.listAll();
    return res.json({ success: true, models });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/models/category/:categoryId  — lista de versiones
const listVersions = async (req, res) => {
  try {
    const categoryId = parseId(req.params.categoryId, 'Category ID');
    const versions = await modelVersioningService.listVersions(categoryId);
    return res.json({ success: true, versions });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { listAll, listVersions };
