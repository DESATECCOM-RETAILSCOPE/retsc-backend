// Controller del módulo de revisión de anotaciones (Issue 7.5).
// Rutas asociadas: /api/annotations
//
// La autorización por rol (Admin / Supervisor) se aplica en annotationRoutes.js
// con requireRole; aquí solo se asume que req.user ya existe (authMiddleware).

const annotationService     = require('../services/annotationService');
const annotationRepo        = require('../repositories/annotationRepo');
const annotationSyncService = require('../services/annotationSyncService');

// Duplicado deliberado de la misma lista en shelfPhotoUploadService.js /
// annotationSyncService.js — no hay un módulo compartido de constantes de canal
// hoy y no vale la pena crear uno para 3 usos idénticos.
const CANALES_VALIDOS = ['OMT', 'DTT', 'CONVENIENCE'];

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

// GET /api/annotations/photos — review queue global (Issues 8.2 + menú por rol 2026-07-25).
// listPhotos/getPhotoWithRegions/approvePhoto ya existían en annotationRepo.js sin ninguna
// ruta que las llamara (código muerto documentado en CLAUDE.md como "pendiente de un
// futuro endpoint de review queue") — este es ese endpoint.
// Query params opcionales: categoryId, canal, status. A diferencia de GET /photo/:photoId
// (abierta a cualquier autenticado), esta va gateada por canValidate en las rutas —
// alimenta las pantallas "Anotaciones" (ADMIN_DTC) y "Revisar cajitas" (ADMIN) del menú.
const listPhotos = async (req, res) => {
  try {
    const { categoryId, canal, status } = req.query;

    if (canal && !CANALES_VALIDOS.includes(canal)) {
      return res.status(400).json({
        success: false,
        message: `canal inválido: '${canal}'. Debe ser uno de: ${CANALES_VALIDOS.join(', ')}.`,
      });
    }

    const photos = await annotationRepo.listPhotos({
      categoryId: categoryId != null ? parseId(categoryId, 'categoryId') : undefined,
      canal,
      status,
    });
    return res.json({ success: true, photos });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/annotations/photos/:photoId — detalle de una foto con todas sus cajitas
const getPhotoDetail = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const photo = await annotationRepo.getPhotoWithRegions(photoId);
    if (!photo) {
      return res.status(404).json({ success: false, message: `Foto ${photoId} no encontrada.` });
    }
    return res.json({ success: true, photo });
  } catch (err) {
    return handleError(res, err);
  }
};

// PATCH /api/annotations/photos/:photoId/approve — aprueba TODAS las cajitas de la foto
// de una sola vez (approvePhoto) y dispara la sincronización con Custom Vision.
// Body opcional: { clienteAjustoCajitas?: boolean }, default true.
//
// NOTA: hasta ahora el único disparador de annotationSyncService.syncApprovedPhoto() era
// el Issue #54 (externo, todavía no integrado en este repo) — esta ruta es un SEGUNDO
// disparador. Si #54 se integra más adelante, hay que decidir cuál de los dos llama a
// syncApprovedPhoto para no sincronizar la misma foto dos veces. No es urgente resolverlo
// ahora: syncRegionsForPhoto ya es idempotente por cv_region_id (ver splitByCvRegionId en
// annotationSyncService.js), así que una doble llamada no duplica regiones en Custom
// Vision, pero sí sería trabajo/llamadas HTTP redundantes.
//
// reviewerId sale SIEMPRE de req.user.userId, nunca del body — evita que alguien apruebe
// "en nombre de" otro usuario.
const approvePhoto = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const clienteAjustoCajitas = req.body?.clienteAjustoCajitas !== false;

    const annotations = await annotationRepo.approvePhoto(photoId, req.user.userId);
    if (!annotations.length) {
      return res.status(404).json({ success: false, message: `Foto ${photoId} no encontrada o sin anotaciones.` });
    }

    // syncApprovedPhoto nunca lanza por fallos de Custom Vision (por diseño, ver su propio
    // header) — la aprobación ya quedó persistida en SQL en la línea de arriba y no se
    // revierte por un problema de sincronización. El resultado se devuelve igual para que
    // el frontend pueda avisar "aprobada, pero la sincronización con Custom Vision falló".
    const sync = await annotationSyncService.syncApprovedPhoto(photoId, { clienteAjustoCajitas });

    return res.json({ success: true, annotations, sync });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { approve, correct, reject, listByPhoto, readiness, listPhotos, getPhotoDetail, approvePhoto };
