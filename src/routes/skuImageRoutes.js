// Rutas de imágenes de SKU.
// Prefijo en app.js: /api/sku-images

const express        = require('express');
const multer         = require('multer');
const router         = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const c              = require('../controllers/skuImageController');

const upload = multer({
  dest: 'uploads-temp/',
  limits: {
    fileSize: 10 * 1024 * 1024,   // 10 MB por archivo
    files:    200,                  // máximo 200 archivos por batch
  },
  fileFilter: (_req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Formato no soportado. Solo se aceptan JPG, PNG y WEBP.'), { statusCode: 400 }));
    }
  },
});

// Manejador de errores de multer (fileFilter, fileSize) para devolver JSON coherente.
function multerErrorHandler(err, req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'Archivo demasiado grande. Máximo 10 MB por imagen.' });
  }
  if (err) {
    return res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
  next();
}

/**
 * @swagger
 * components:
 *   schemas:
 *     SkuImageJob:
 *       type: object
 *       properties:
 *         job_id:        { type: integer }
 *         user_id:       { type: integer }
 *         enterprise_id: { type: integer, nullable: true }
 *         job_type:      { type: string, example: SKU_IMAGE_UPLOAD }
 *         status:        { type: string, enum: [QUEUED, RUNNING, COMPLETED, FAILED] }
 *         total_files:   { type: integer }
 *         processed:     { type: integer, nullable: true }
 *         orphans:       { type: integer, nullable: true, description: "Imágenes cuyo EAN no matcheó ningún SKU (flujo huérfanas)" }
 *         duplicates:    { type: integer, nullable: true }
 *         error_count:   { type: integer, nullable: true }
 *         errorSummary:  { type: object, nullable: true, description: "Parseado desde JSON si el driver lo devuelve como string" }
 *         loadNumber:    { type: integer, nullable: true, description: "Secuencia por empresa — solo poblado en el listado de GET /jobs" }
 *         started_at:    { type: string, format: date-time, nullable: true }
 *         completed_at:  { type: string, format: date-time, nullable: true }
 *     SkuImageFeature:
 *       type: object
 *       description: Fila de RETSC_AI_SKU_FEATURES (SELECT * — puede incluir más columnas que las listadas)
 *       properties:
 *         feature_id:        { type: integer }
 *         sku_id:            { type: integer }
 *         image_url:         { type: string, example: /blob-mock/dtc-snacks/7501234567890.jpg }
 *         image_hash:        { type: string, description: "Hash de contenido, usado para detectar duplicados" }
 *         is_primary:        { type: boolean }
 *         validation_status: { type: string, nullable: true, enum: [VALID, LOW_RESOLUTION, BLURRY, POOR_LIGHTING] }
 *         created_at:        { type: string, format: date-time }
 */

/**
 * @swagger
 * /api/sku-images/upload:
 *   post:
 *     summary: Sube hasta 200 imágenes de SKU en batch (encola job asíncrono)
 *     tags: [SkuImages]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Cada archivo debe nombrarse "{EAN}_{vista}.{ext}" (ver
 *       skuImageFilenameParser). El flujo por archivo: parsea el nombre, calcula
 *       hash de contenido, busca el SKU por EAN — si no existe, sube a la carpeta
 *       "huerfanas/" y registra el intento con process_status=ORPHAN sin insertar
 *       en RETSC_AI_SKU_FEATURES (se adopta retroactivamente cuando el SKU se crea
 *       después); si existe, resuelve el prefijo de blob según la categoría AI del
 *       SKU, sube el archivo, inserta la feature y loguea el intento. El endpoint
 *       NO espera a que termine el procesamiento: encola un job en RETSC_LOG_JOBS
 *       y devuelve 202 de inmediato. Pollear el progreso con GET /jobs/{jobId}.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [images]
 *             properties:
 *               images:
 *                 type: array
 *                 items: { type: string, format: binary }
 *                 description: "Hasta 200 archivos jpg/jpeg/png/webp, máx 10 MB cada uno. Campo de formulario: images[]"
 *     responses:
 *       202:
 *         description: Job encolado — el procesamiento corre en background
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 jobId:      { type: integer }
 *                 status:     { type: string, example: QUEUED }
 *                 totalFiles: { type: integer }
 *       400:
 *         description: >-
 *           No se enviaron imágenes, formato no soportado (solo jpg/jpeg/png/webp),
 *           o archivo mayor a 10 MB
 *       401:
 *         description: Sin token, o token expirado
 */
router.post('/upload',
  authMiddleware,
  upload.array('images', 200),
  multerErrorHandler,
  c.uploadImages,
);

/**
 * @swagger
 * /api/sku-images/jobs:
 *   get:
 *     summary: Lista los jobs de carga de imágenes del usuario autenticado
 *     tags: [SkuImages]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Declarada antes de /sku/{skuId} en el router para que Express no la trate
 *       como un skuId literal "jobs". Ordenado del más reciente al más viejo;
 *       cada job incluye loadNumber (secuencia calculada por empresa).
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *         description: Tope 50 — valores mayores se recortan silenciosamente
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Jobs del usuario
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 jobs:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/SkuImageJob' }
 *       401:
 *         description: Sin token, o token expirado
 */
router.get('/jobs',        authMiddleware, c.listMyJobs);

/**
 * @swagger
 * /api/sku-images/jobs/{jobId}:
 *   get:
 *     summary: Consulta el estado y los contadores de un job de carga
 *     tags: [SkuImages]
 *     security:
 *       - bearerAuth: []
 *     description: Pensado para polling desde el cliente mientras el batch de /upload procesa en background.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Estado actual del job
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 job:     { $ref: '#/components/schemas/SkuImageJob' }
 *       400:
 *         description: jobId no es un número
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: El job existe pero pertenece a otro usuario
 *       404:
 *         description: Job no encontrado
 */
router.get('/jobs/:jobId', authMiddleware, c.getJobStatus);

/**
 * @swagger
 * /api/sku-images/sku/{skuId}:
 *   get:
 *     summary: Lista las imágenes registradas de un SKU
 *     tags: [SkuImages]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Devuelve las filas de RETSC_AI_SKU_FEATURES para ese SKU, la primaria
 *       primero (is_primary DESC) y luego por antigüedad de carga.
 *     parameters:
 *       - in: path
 *         name: skuId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Imágenes del SKU
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 images:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/SkuImageFeature' }
 *       400:
 *         description: skuId no es un número
 *       401:
 *         description: Sin token, o token expirado
 */
router.get('/sku/:skuId', authMiddleware, c.listBySku);

/**
 * @swagger
 * /api/sku-images/{featureId}/validate:
 *   post:
 *     summary: Corre el gate local de calidad de imagen sobre una feature ya cargada (Issue 6.1)
 *     tags: [SkuImages]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Cualquier usuario autenticado puede disparar la validación. Resuelve el
 *       path del blob (local en modo mock, descarga temporal en modo Azure),
 *       corre imageValidationService (resolución mínima, nitidez por varianza de
 *       Laplaciano, brillo promedio), persiste validation_status en
 *       RETSC_AI_SKU_FEATURES y registra el intento en RETSC_LOG_IMAGE_UPLOAD
 *       (best effort — un fallo de log no rompe la respuesta).
 *     parameters:
 *       - in: path
 *         name: featureId
 *         required: true
 *         schema: { type: integer }
 *         description: Feature_id de RETSC_AI_SKU_FEATURES
 *     responses:
 *       200:
 *         description: Resultado de la validación
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:   { type: boolean, example: true }
 *                 featureId: { type: integer }
 *                 status:    { type: string, enum: [VALID, LOW_RESOLUTION, BLURRY, POOR_LIGHTING] }
 *                 metrics:
 *                   type: object
 *                   properties:
 *                     width:      { type: integer }
 *                     height:     { type: integer }
 *                     sharpness:  { type: number, description: "Varianza del Laplaciano" }
 *                     brightness: { type: number, description: "Brillo promedio, escala 0-255" }
 *                 failures:
 *                   type: array
 *                   items: { type: string }
 *                   description: Todos los criterios que fallaron, no solo el primero reportado en status
 *       400:
 *         description: featureId no es un número
 *       401:
 *         description: Sin token, o token expirado
 *       404:
 *         description: Feature no encontrada
 *       422:
 *         description: La feature no tiene image_url asociada, o no se pudo extraer el blobPath (modo Azure)
 *       503:
 *         description: Modo Azure sin AZURE_STORAGE_CONNECTION_STRING configurada
 */
router.post('/:featureId/validate', authMiddleware, c.validateImageQuality);

module.exports = router;
