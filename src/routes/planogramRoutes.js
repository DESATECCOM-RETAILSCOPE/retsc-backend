// Ciclo 5 · B2 — Rutas de planogramas. Prefijo en app.js: /api/planograms (con authMiddleware).
// Acceso: roles de PLANOGRAM_ROLES (CSV, default ADMIN). Decisión ciclo 5: los planogramas los sube
// el ADMIN de cada empresa — el planograma queda a nombre de la empresa de la sesión (Enterprise_id),
// así que un usuario de DTC no puede cargarlos por un cliente (quedarían a nombre de DTC).

const express     = require('express');
const multer      = require('multer');
const router      = express.Router();
const requireRole = require('../middlewares/requireRole');
const c           = require('../controllers/planogramController');

const PLANOGRAM_ROLES = (process.env.PLANOGRAM_ROLES || 'ADMIN')
  .split(',').map((s) => s.trim()).filter(Boolean);
const canUse = requireRole(...PLANOGRAM_ROLES);

const upload = multer({
  dest: 'uploads-temp/',
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },   // planogramas: PDF o imágenes grandes y detalladas
  fileFilter: (_req, file, cb) => {
    if (/\.(pdf|jpg|jpeg|png)$/i.test(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error('El planograma debe ser un PDF (o una imagen JPG/PNG).'), { statusCode: 400, errorCode: 'ERR_FORMATO_NO_SOPORTADO' }));
  },
});

// Mapeo de códigos de cadena: CSV/TXT chico.
const uploadCsv = multer({
  dest: 'uploads-temp/',
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/\.(csv|txt)$/i.test(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error('El mapeo de códigos debe ser un archivo CSV (codigo,ean).'), { statusCode: 400, errorCode: 'ERR_FORMATO_NO_SOPORTADO' }));
  },
});

function multerErrorHandler(err, _req, res, next) {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, errorCode: 'ERR_ARCHIVO_DEMASIADO_GRANDE', message: 'Archivo demasiado grande. Máximo 15 MB.' });
  }
  if (err) return res.status(err.statusCode || 400).json({ success: false, errorCode: err.errorCode || 'ERR_UPLOAD', message: err.message });
  next();
}

/**
 * @swagger
 * tags:
 *   - name: Planograms
 *     description: Carga y consulta de planogramas por tienda y categoría (ciclo 5, B2)
 *
 * /api/planograms/catalogos:
 *   get:
 *     summary: Cadenas y tiendas para el formulario de carga
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: "{ success, chains: [{ supermarketchainId, name }], retailers: [{ retailerId, name, supermarketchainId, formato }] }" } }
 *
 * /api/planograms:
 *   get:
 *     summary: Planogramas de la empresa de la sesión
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [BORRADOR, ACTIVO, INACTIVO] } }
 *       - { in: query, name: categoryId, schema: { type: integer } }
 *       - { in: query, name: retailerId, schema: { type: integer } }
 *     responses: { 200: { description: "{ success, planograms: [...] }" } }
 *   post:
 *     summary: Carga un planograma (PDF o imagen + encabezado en BORRADOR). Un PDF se interpreta en segundo plano (ver /{seq}/propuesta)
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [image, categoryId, supermarketchainId, upDate, flowDirection]
 *             properties:
 *               image:              { type: string, format: binary, description: "PDF (se interpreta) o JPG/PNG, máx. 15 MB" }
 *               categoryId:         { type: integer }
 *               supermarketchainId: { type: integer }
 *               retailerId:         { type: integer, description: "Opcional. Debe pertenecer a la cadena. Vacío = todas las tiendas de la cadena (Retailer_id NULL)" }
 *               upDate:             { type: string, format: date }
 *               downDate:           { type: string, format: date, description: "Opcional, >= upDate" }
 *               flowDirection:      { type: string, enum: [IZQ_DER, DER_IZQ] }
 *               notes:              { type: string, maxLength: 255 }
 *     responses:
 *       201: { description: "{ success, planogram }" }
 *       400: { description: "Validación (errorCode: ERR_TIENDA_NO_ES_DE_LA_CADENA, ERR_VIGENCIA_INVALIDA, ERR_CATEGORIA_NO_HABILITADA, ERR_FORMATO_DEMASIADO_LARGO, …)" }
 *
 * /api/planograms/{seq}:
 *   get:
 *     summary: Detalle de un planograma de la empresa
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: seq, required: true, schema: { type: integer } }]
 *
 * /api/planograms/{seq}/image:
 *   get:
 *     summary: Archivo original del planograma (PDF o imagen, bytes)
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: seq, required: true, schema: { type: integer } }]
 *
 * /api/planograms/{seq}/propuesta:
 *   get:
 *     summary: Resultado de la interpretación del PDF (Fase 8)
 *     description: "estado = PROCESANDO | LISTO | ERROR | SIN_INTERPRETAR | NO_APLICA (cargado como imagen). LISTO trae { formato, propuesta: { muebles → niveles → posiciones, resumen, advertencias } }."
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: seq, required: true, schema: { type: integer } }]
 *
 * /api/planograms/{seq}/dibujo:
 *   get:
 *     summary: Dibujo del planograma (página 1 del PDF en PNG); las cajas de la propuesta son relativas a esta imagen
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: seq, required: true, schema: { type: integer } }]
 *
 * /api/planograms/{seq}/interpretar:
 *   post:
 *     summary: Vuelve a interpretar el PDF (solo BORRADOR). Responde 202 sin esperar el resultado
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: seq, required: true, schema: { type: integer } }]
 *     responses: { 202: { description: "{ success, estado: PROCESANDO }" }, 409: { description: "ERR_INTERPRETACION_EN_CURSO | ERR_NO_ES_BORRADOR" } }
 *
 * /api/planograms/{seq}/propuesta (PUT):
 *   put:
 *     summary: Guarda la revisión (Fase 8.7). Body { muebles → niveles → posiciones } como lo devuelve GET; se renumeran las columnas en el orden recibido y se valida cada sku_id contra el catálogo
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: seq, required: true, schema: { type: integer } }]
 *     responses: { 200: { description: "Mismo formato que GET /propuesta (con precision)" }, 400: { description: "ERR_REVISION_INVALIDA | ERR_SKU_NO_EXISTE" }, 409: { description: "ERR_NO_ES_BORRADOR | ERR_PROPUESTA_NO_LISTA" } }
 *
 * /api/planograms/{seq}/aprobar:
 *   post:
 *     summary: Aprueba (Fase 8.8) — en una transacción graba RETSC_OP_PLANOGRAMDET, inactiva el ACTIVO anterior del mismo alcance (tienda o toda la cadena) y activa este
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: seq, required: true, schema: { type: integer } }]
 *     responses: { 200: { description: "{ success, filas, inactivados, planogram }" }, 409: { description: "ERR_POSICIONES_SIN_SKU (con pendientes) | ERR_NO_ES_BORRADOR | ERR_SKU_NO_EXISTE" } }
 *
 * /api/planograms/{seq}/detalle:
 *   get:
 *     summary: Filas grabadas en RETSC_OP_PLANOGRAMDET (planograma aprobado)
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: seq, required: true, schema: { type: integer } }]
 *
 * /api/planograms/skus:
 *   get:
 *     summary: Buscador de SKU para la revisión — por EAN (con/sin ceros, sin dígito verificador) o por descripción
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: q, required: true, schema: { type: string } }]
 *
 * /api/planograms/codigos-cadena:
 *   get:
 *     summary: Resumen del mapeo código de cadena → EAN de la empresa para una cadena
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: supermarketchainId, required: true, schema: { type: integer } }]
 *   post:
 *     summary: Carga (reemplaza) el mapeo con un CSV de 2 columnas codigo,ean (encabezado opcional; separador , ; o tab)
 *     tags: [Planograms]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [archivo, supermarketchainId]
 *             properties:
 *               archivo:            { type: string, format: binary }
 *               supermarketchainId: { type: integer }
 */
router.get('/catalogos',  canUse, c.getCatalogs);
router.get('/skus',            canUse, c.buscarSkus);
router.get('/codigos-cadena',  canUse, c.getMapeoCodigos);
router.post('/codigos-cadena', canUse, uploadCsv.single('archivo'), multerErrorHandler, c.cargarMapeoCodigos);
router.get('/',           canUse, c.list);
router.post('/',          canUse, upload.single('image'), multerErrorHandler, c.create);
router.get('/:seq',       canUse, c.getOne);
router.get('/:seq/image', canUse, c.getImage);
router.get('/:seq/propuesta',    canUse, c.getPropuesta);
router.get('/:seq/dibujo',       canUse, c.getDibujo);
router.post('/:seq/interpretar', canUse, c.reinterpretar);
router.put('/:seq/propuesta',    canUse, c.guardarRevision);
router.post('/:seq/aprobar',     canUse, c.aprobar);
router.get('/:seq/detalle',      canUse, c.getDetalle);

module.exports = router;
