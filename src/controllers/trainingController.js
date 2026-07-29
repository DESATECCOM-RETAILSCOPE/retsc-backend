// Controller de entrenamiento de modelos Custom Vision (Issue 8.3).
// Ruta asociada: POST /api/training/models/:categoryId/train
//
// Fire-and-forget: responde 202 sin esperar a que Custom Vision termine de entrenar. El
// progreso se consulta con GET /api/models/category/:categoryId (ya existe, Issue 8.5).
//
// La autorización (rol admin) se aplica en trainingRoutes.js con requireRole; acá se asume
// que req.user ya existe (authMiddleware).

const modelTrainingService = require('../services/modelTrainingService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[training]', err);
  return res.status(status).json({ success: false, message: err.message });
}

function parseId(value, label) {
  const id = parseInt(value, 10);
  if (isNaN(id)) throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  return id;
}

// POST /api/training/models/:categoryId/train — inicia el entrenamiento (202, no bloquea)
const train = async (req, res) => {
  try {
    const categoryId = parseId(req.params.categoryId, 'Category ID');
    const result = await modelTrainingService.startTraining(categoryId, req.user.userId);
    return res.status(202).json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { train };
