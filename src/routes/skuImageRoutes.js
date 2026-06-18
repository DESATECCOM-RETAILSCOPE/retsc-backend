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

// Upload → encola y devuelve 202
router.post('/upload',
  authMiddleware,
  upload.array('images', 200),
  multerErrorHandler,
  c.uploadImages,
);

// Jobs: /jobs debe ir ANTES de /sku/:skuId para evitar ambigüedad en rutas
router.get('/jobs',        authMiddleware, c.listMyJobs);
router.get('/jobs/:jobId', authMiddleware, c.getJobStatus);

router.get('/sku/:skuId', authMiddleware, c.listBySku);

// Validación de calidad de imagen (Issue 6.1)
// POST /api/sku-images/:featureId/validate
// Cualquier usuario autenticado puede disparar la validación.
router.post('/:featureId/validate', authMiddleware, c.validateImageQuality);

module.exports = router;
