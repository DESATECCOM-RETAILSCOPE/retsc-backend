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

// POST /api/shelf-photos/upload
router.post('/upload',
  canUpload,
  upload.single('photo'),
  multerErrorHandler,
  c.uploadPhoto,
);

module.exports = router;
