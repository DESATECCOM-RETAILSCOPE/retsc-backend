// Controller para fotos de góndola. Rutas asociadas: /api/shelf-photos
//
// Dos flujos distintos conviven en este archivo:
//   - uploadPhoto        → fotos GLOBALES de entrenamiento (Issue 7.2, sin enterprise/visita)
//   - uploadVisitPhoto   → fotos de VISITA real, Pasos 1-2 de la guía "Fotos de Visita" v1.9
//                          (María Royo), amarradas a un Visit_id/enterprise/PDV concretos
//   - listUnidentified   → sección 8.4 de la guía: productos no identificados para el
//                          dashboard web ("aquí te falta inteligencia...")
//
// Sigue el mismo patrón que skuImageController: handleError con statusCode,
// limpieza del temp de multer en finally.

const fs                      = require('fs').promises;
const { uploadShelfPhoto }    = require('../services/shelfPhotoUploadService');
const { uploadVisitPhoto: uploadVisitPhotoSvc } = require('../services/visitPhotoService');
const shelfPhotoDetectionRepo  = require('../repositories/shelfPhotoDetectionRepo');
const { ROLES, normalizeRole } = require('../config/roles');

function handleError(res, err) {
  const status    = err.statusCode || 500;
  const errorCode = err.errorCode  || undefined;
  if (status === 500) console.error('[shelfPhoto]', err);
  return res.status(status).json({
    success: false,
    ...(errorCode && { errorCode }),
    message: err.message,
  });
}

// POST /api/shelf-photos/upload
// Multipart: campo de archivo "photo" + campos dtcCategoryId y canal.
// Solo Admins (ver requireRole en la ruta).
const uploadPhoto = async (req, res) => {
  const filePath = req.file?.path ?? null;

  try {
    // Validación de archivo (multer ya filtra extensión y tamaño; aquí verificamos presencia).
    if (!req.file) {
      return res.status(400).json({
        success:   false,
        errorCode: 'ERR_ARCHIVO_REQUERIDO',
        message:   'Se requiere el campo "photo" con una imagen (jpg/jpeg/png/webp, máx 10 MB).',
      });
    }

    const { dtcCategoryId, canal } = req.body;

    // Leer buffer aquí para pasarlo al servicio y poder hacer unlink en finally.
    const buffer = await fs.readFile(req.file.path);

    const result = await uploadShelfPhoto({
      buffer,
      dtcCategoryId,
      canal,
      uploadedBy: req.user.userId,
      enterpriseId: req.user.enterpriseId ?? null,
    });

    return res.status(201).json({ success: true, ...result });

  } catch (err) {
    return handleError(res, err);
  } finally {
    // Limpia siempre el archivo temporal de multer, independientemente del resultado.
    if (filePath) await fs.unlink(filePath).catch(() => {});
  }
};

// POST /api/shelf-photos/visit
// Multipart: campo de archivo "photo" + campos visitId, categoryId, shelfunitId (REQUERIDO
// desde la reformulación del DBA 2026-08-07 — RETSC_EX_SHELFPHOTO.Shelfunit_id es NOT NULL),
// qualityStatus, blurScore, brightness (estos 3 últimos YA calculados por el mobile — ver
// guía sección 3, "aquí no se vuelve a validar eso, solo se guarda").
// Roles móviles + admin (ver VISIT_ROLES/requireRole en la ruta) — es el flujo de
// producción del auditor/gerente en tienda, no el de carga de entrenamiento de arriba.
const uploadVisitPhoto = async (req, res) => {
  const filePath = req.file?.path ?? null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success:   false,
        errorCode: 'ERR_ARCHIVO_REQUERIDO',
        message:   'Se requiere el campo "photo" con una imagen (jpg/jpeg/png/webp, máx 10 MB).',
      });
    }

    const { visitId, categoryId, shelfunitId, qualityStatus, blurScore, brightness } = req.body;
    const buffer = await fs.readFile(req.file.path);

    const result = await uploadVisitPhotoSvc({
      buffer,
      visitId,
      categoryId,
      shelfunitId,
      qualityStatus,
      blurScore,
      brightness,
      uploadedBy: req.user.userId,
    });

    return res.status(201).json({ success: true, ...result });

  } catch (err) {
    return handleError(res, err);
  } finally {
    if (filePath) await fs.unlink(filePath).catch(() => {});
  }
};

// GET /api/shelf-photos/unidentified
// Sección 8.4 de la guía — "productos no identificados, posibles productos nuevos en
// góndola". Visibilidad pasiva del dashboard web: ADMIN/ADMIN_DTC ven cualquier enterprise
// (vía query param enterpriseId); un enterprise común solo ve el suyo (req.user.enterpriseId),
// mismo criterio de scoping que el resto del repo (ver GET /api/enterprises/:id).
const listUnidentified = async (req, res) => {
  try {
    const isAdminDtc = normalizeRole(req.user.roleName) === ROLES.ADMIN_DTC;
    const requestedEnterpriseId = req.query.enterpriseId != null ? parseInt(req.query.enterpriseId, 10) : null;

    let enterpriseId = req.user.enterpriseId;
    if (isAdminDtc && requestedEnterpriseId) {
      enterpriseId = requestedEnterpriseId;
    } else if (!isAdminDtc && requestedEnterpriseId && requestedEnterpriseId !== req.user.enterpriseId) {
      return res.status(403).json({ success: false, message: 'No puedes ver los productos no identificados de otro enterprise.' });
    }

    const detections = await shelfPhotoDetectionRepo.listUnidentifiedByEnterprise(enterpriseId);
    return res.json({ success: true, detections });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { uploadPhoto, uploadVisitPhoto, listUnidentified };
