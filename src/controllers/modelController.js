// Controller de gestión de versiones de modelos (Issue 8.5).
// Rutas asociadas: /api/models
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

// GET /api/models/category/:categoryId/can-retrain  — chequeo de la regla de 20 fotos
const canRetrain = async (req, res) => {
  try {
    const categoryId = parseId(req.params.categoryId, 'Category ID');
    const status = await modelVersioningService.canRetrain(categoryId);
    return res.json({ success: true, ...status });
  } catch (err) {
    return handleError(res, err);
  }
};

// POST /api/models/category/:categoryId/retrain  — inicia un re-entrenamiento
const retrain = async (req, res) => {
  try {
    const categoryId = parseId(req.params.categoryId, 'Category ID');
    const model = await modelVersioningService.startRetrain(categoryId);
    return res.status(202).json({ success: true, model });
  } catch (err) {
    return handleError(res, err);
  }
};

// POST /api/models/:modelId/complete  — carga métricas y decide activación/aprobación
// Body: { precision, recall, meanAp, raw? }
const complete = async (req, res) => {
  try {
    const modelId = parseId(req.params.modelId, 'Model ID');
    const { precision, recall, meanAp, raw } = req.body;
    const result = await modelVersioningService.completeRetrain(modelId, { precision, recall, meanAp, raw });
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
};

// POST /api/models/:modelId/approve  — aprueba una versión con métricas peores
const approve = async (req, res) => {
  try {
    const modelId = parseId(req.params.modelId, 'Model ID');
    const model = await modelVersioningService.approveVersion(modelId, req.user.userId);
    return res.json({ success: true, model });
  } catch (err) {
    return handleError(res, err);
  }
};

// POST /api/models/:modelId/reject  — rechaza una versión con métricas peores
const reject = async (req, res) => {
  try {
    const modelId = parseId(req.params.modelId, 'Model ID');
    const model = await modelVersioningService.rejectVersion(modelId, req.user.userId);
    return res.json({ success: true, model });
  } catch (err) {
    return handleError(res, err);
  }
};

// POST /api/models/category/:categoryId/rollback/:version  — reactiva una versión anterior
const rollback = async (req, res) => {
  try {
    const categoryId = parseId(req.params.categoryId, 'Category ID');
    const version = parseId(req.params.version, 'Version');
    const model = await modelVersioningService.rollback(categoryId, version);
    return res.json({ success: true, model });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { listAll, listVersions, canRetrain, retrain, complete, approve, reject, rollback };
