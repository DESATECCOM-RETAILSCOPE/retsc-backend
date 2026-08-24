// Rutas para la carga de fotos de góndola globales (Issue 7.2).
// Prefijo en app.js: /api/shelf-photos  (montado con authMiddleware)
//
// Acceso restringido a roles configurables por env SHELF_UPLOAD_ROLES (CSV).
// Default: 'Admin'. Sigue el mismo patrón de roles que modelRoutes.js.

const express     = require('express');
const multer      = require('multer');
const router      = express.Router();
const requireRole = require('../middlewares/requireRole');
const c           = require('../controllers/shelfPhotoController');

const UPLOAD_ROLES = (process.env.SHELF_UPLOAD_ROLES || 'ADMIN,ADMIN_DTC')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const canUpload = requireRole(...UPLOAD_ROLES);

// Roles que pueden subir fotos de VISITA (Pasos 1-2, guía v1.9) — distinto de
// SHELF_UPLOAD_ROLES de arriba (ese es para la carga de entrenamiento por un Admin).
// Mismo default que visitRoutes.js (VISIT_ROLES).
const VISIT_UPLOAD_ROLES = (process.env.VISIT_ROLES || 'AUDITOR CAMPO,EJECUTIVO CAMPO,ADMIN,ADMIN_DTC')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const canUploadVisitPhoto = requireRole(...VISIT_UPLOAD_ROLES);

const upload = multer({
  dest: 'uploads-temp/',
  limits: {
    fileSize: 10 * 1024 * 1024,  // 10 MB
    files:    1,
  },
  fileFilter: (_req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(Object.assign(
        new Error('Formato no soportado. Solo se aceptan JPG, JPEG, PNG y WEBP.'),
        { statusCode: 400, errorCode: 'ERR_FORMATO_NO_SOPORTADO' }
      ));
    }
  },
});

function multerErrorHandler(err, req, res, next) {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success:   false,
      errorCode: 'ERR_ARCHIVO_DEMASIADO_GRANDE',
      message:   'Archivo demasiado grande. Máximo 10 MB.',
    });
  }
  if (err) {
    return res.status(err.statusCode || 400).json({
      success:   false,
      errorCode: err.errorCode || 'ERR_UPLOAD',
      message:   err.message,
    });
  }
  next();
}

/**
 * @swagger
 * /api/shelf-photos/upload:
 *   post:
 *     summary: Sube una foto GLOBAL de entrenamiento (Issue 7.2)
 *     tags: [ShelfPhotos]
 *     security:
 *       - bearerAuth: []
 *     description: Distinto de POST /api/shelf-photos/visit — este flujo es de
 *       ENTRENAMIENTO (sin enterprise/visita), pasa por el gate de calidad de 8 etapas y
 *       solo lo puede usar un rol de SHELF_UPLOAD_ROLES (default ADMIN,ADMIN_DTC).
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [photo, canal, dtcCategoryId]
 *             properties:
 *               photo:         { type: string, format: binary, description: "jpg/jpeg/png/webp, máx 10 MB" }
 *               canal:         { type: string, enum: [OMT, DTT, CONVENIENCE] }
 *               dtcCategoryId: { type: integer, description: "Categoría DTC smart" }
 *     responses:
 *       201:
 *         description: Foto registrada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 photoId:          { type: integer }
 *                 blobPath:         { type: string }
 *                 blobUrl:          { type: string }
 *                 blobMode:         { type: string, example: mock }
 *                 cvImageId:        { type: string, nullable: true, description: "Se registra en Custom Vision recién al aprobar la anotación" }
 *                 canal:            { type: string }
 *                 dtcCategoryId:    { type: integer }
 *                 channelCount:     { type: integer }
 *                 thresholdReached: { type: boolean }
 *       400:
 *         description: Archivo/canal/categoría faltante o inválido (ERR_ARCHIVO_REQUERIDO, ERR_CANAL_REQUERIDO, ERR_CANAL_INVALIDO, ERR_CATEGORIA_REQUERIDA, ERR_ARCHIVO_DEMASIADO_GRANDE, ERR_FORMATO_NO_SOPORTADO)
 *       404:
 *         description: Categoría no encontrada (ERR_CATEGORIA_NO_ENCONTRADA)
 *       409:
 *         description: Imagen duplicada en ese canal (ERR_DUPLICATE_IMAGE)
 *       422:
 *         description: La imagen no cumple los criterios de calidad (errorCode = el motivo del rechazo)
 */
router.post('/upload',
  canUpload,
  upload.single('photo'),
  multerErrorHandler,
  c.uploadPhoto,
);

/**
 * @swagger
 * /api/shelf-photos/visit:
 *   post:
 *     summary: Sube una foto de VISITA real (Pasos 1-2, guía Fotos de Visita v1.9)
 *     tags: [ShelfPhotos]
 *     security:
 *       - bearerAuth: []
 *     description: La foto llega ya validada por el mobile (blur/luz/encuadre) — este
 *       endpoint NO vuelve a validar calidad, solo guarda quality_status/blur_score/
 *       brightness tal cual como registro de auditoría. Dispara la detección (Pasos 3-5)
 *       en background — el 201 no espera a Custom Vision/OCR.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [photo, visitId, categoryId, shelfunitId]
 *             properties:
 *               photo:         { type: string, format: binary, description: "jpg/jpeg/png/webp, máx 10 MB" }
 *               visitId:       { type: integer, description: "Visit_id devuelto al abrir la visita (Paso 0)" }
 *               categoryId:    { type: integer, description: "Categoría seleccionada en el mobile para esta foto" }
 *               shelfunitId:   { type: integer, description: "REQUERIDO — RETSC_EX_SHELFPHOTO.Shelfunit_id es NOT NULL" }
 *               qualityStatus: { type: string, description: "Ya calculado por el mobile (Paso 3 de la guía)" }
 *               blurScore:     { type: number, format: float }
 *               brightness:    { type: number, format: float }
 *     responses:
 *       201:
 *         description: Foto registrada, detección corriendo en background
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 photoId:    { type: integer }
 *                 visitId:    { type: integer }
 *                 categoryId: { type: integer }
 *                 blobPath:   { type: string }
 *                 blobUrl:    { type: string }
 *       400:
 *         description: Archivo/visitId/categoryId/shelfunitId faltante (ERR_ARCHIVO_REQUERIDO, ERR_VISIT_ID_REQUERIDO, ERR_CATEGORIA_REQUERIDA, ERR_SHELFUNIT_REQUERIDO)
 *       403:
 *         description: La visita pertenece a otro usuario (ERR_VISITA_AJENA)
 *       404:
 *         description: Visita o categoría no encontrada (ERR_VISITA_NO_ENCONTRADA, ERR_CATEGORIA_NO_ENCONTRADA)
 *       409:
 *         description: La visita ya está cerrada (ERR_VISITA_CERRADA)
 */
router.post('/visit',
  canUploadVisitPhoto,
  upload.single('photo'),
  multerErrorHandler,
  c.uploadVisitPhoto,
);

/**
 * @swagger
 * /api/shelf-photos/unidentified:
 *   get:
 *     summary: Productos detectados sin identificar (sección 8.4, guía Fotos de Visita v1.9)
 *     tags: [ShelfPhotos]
 *     security:
 *       - bearerAuth: []
 *     description: Alimenta el "aquí te falta inteligencia..." del dashboard web. Cualquier
 *       autenticado puede llamarlo — el scoping por enterprise vive en el controller, no en
 *       requireRole. Un ADMIN/ADMIN_DTC puede pasar ?enterpriseId= para ver el de otra
 *       empresa; cualquier otro rol solo ve el suyo (403 si intenta pedir uno ajeno).
 *     parameters:
 *       - in: query
 *         name: enterpriseId
 *         schema: { type: integer }
 *         description: Solo tiene efecto si el caller es ADMIN_DTC; ignorado (o 403 si difiere del propio) para cualquier otro rol.
 *     responses:
 *       200:
 *         description: Detecciones sin Sku_id asignado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 detections:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       Detection_id: { type: integer }
 *                       ocr_text:     { type: string, nullable: true }
 *                       URL_blob:     { type: string }
 *                       Bbox_left:    { type: number }
 *                       Bbox_top:     { type: number }
 *                       Bbox_width:   { type: number }
 *                       Bbox_height:  { type: number }
 *       403:
 *         description: Pediste el enterpriseId de otra empresa sin ser ADMIN_DTC
 */
router.get('/unidentified', c.listUnidentified);

module.exports = router;
