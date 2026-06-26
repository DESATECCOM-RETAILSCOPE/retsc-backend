// Controller del módulo de revisión de anotaciones (Issue 7.5).
// Rutas asociadas: /api/annotations
//
// La autorización por rol (Admin / Supervisor) se aplica en annotationRoutes.js
// con requireRole; aquí solo se asume que req.user ya existe (authMiddleware).

const annotationService = require('../services/annotationService');
const annotationRepo    = require('../repositories/annotationRepo');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[annotation]', err);
  return res.status(status).json({ success: false, message: err.message });
}

function parseId(value, label) {
  const id = parseInt(value, 10);
  if (isNaN(id)) throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  return id;
}

// PATCH /api/annotations/:id/approve  — APROBAR
const approve = async (req, res) => {
  try {
    const id = parseId(req.params.id, 'Annotation ID');
    const annotation = await annotationService.approve(id, req.user.userId);
    return res.json({ success: true, annotation });
  } catch (err) {
    return handleError(res, err);
  }
};

// PATCH /api/annotations/:id  — CORREGIR (coordenadas + validar)
// Body: { bbox_left, bbox_top, bbox_width, bbox_height }
const correct = async (req, res) => {
  try {
    const id = parseId(req.params.id, 'Annotation ID');
    const { bbox_left, bbox_top, bbox_width, bbox_height } = req.body;
    const annotation = await annotationService.correct(
      id,
      { bbox_left, bbox_top, bbox_width, bbox_height },
      req.user.userId,
    );
    return res.json({ success: true, annotation });
  } catch (err) {
    return handleError(res, err);
  }
};

// DELETE /api/annotations/:id  — RECHAZAR (eliminar)
const reject = async (req, res) => {
  try {
    const id = parseId(req.params.id, 'Annotation ID');
    const result = await annotationService.reject(id);
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/annotations/photo/:photoId  — listar anotaciones de una foto
const listByPhoto = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const annotations = await annotationRepo.listByPhoto(photoId);
    return res.json({ success: true, annotations });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/annotations/photo/:photoId/readiness  — ¿lista para Custom Vision?
const readiness = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const status = await annotationService.getPhotoReadiness(photoId);
    return res.json({ success: true, ...status });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { approve, correct, reject, listByPhoto, readiness };
