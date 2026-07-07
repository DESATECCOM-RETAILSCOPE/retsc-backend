// Rutas de fotos de góndola (Issue 7.2).
// Prefijo en app.js: /api/shelf-photos
// Todos los endpoints requieren auth + rol Admin.

const express        = require('express');
const multer         = require('multer');
const router         = express.Router();
const requireAdmin   = require('../middlewares/requireAdmin');
const c              = require('../controllers/shelfPhotoController');

const upload = multer({
  dest: 'uploads-temp/',
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/\.(jpg|jpeg|png)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Solo se aceptan imágenes JPG o PNG.'), { statusCode: 400 }));
    }
  },
});

function multerError(err, req, res, next) {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'Imagen demasiado grande. Máximo 20 MB.' });
  }
  if (err) return res.status(err.statusCode || 400).json({ success: false, message: err.message });
  next();
}

// POST /api/shelf-photos/upload
router.post('/upload',
  requireAdmin,
  upload.single('image'),
  multerError,
  c.upload,
);

module.exports = router;
