const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const router     = express.Router();
const controller = require('../controllers/productController');
const authMiddleware = require('../middlewares/authMiddleware');

const UPLOADS_TEMP = path.join(__dirname, '..', '..', 'uploads-temp');
fs.mkdirSync(UPLOADS_TEMP, { recursive: true });

// Excel: destino fijo, multer asigna nombre único
const excelUpload = multer({
  dest: UPLOADS_TEMP,
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo se aceptan archivos .xlsx o .xls'), ok);
  },
}).single('file');

// Imágenes: diskStorage con directorio temporal por request
const imagesStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!req._multerTmpId) req._multerTmpId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(UPLOADS_TEMP, req._multerTmpId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
const imagesUpload = multer({ storage: imagesStorage }).array('files', 200);

router.post('/upload-excel',              authMiddleware, excelUpload,   controller.uploadExcel);
router.post('/upload-images',             authMiddleware, imagesUpload,  controller.uploadImages);
router.post('/process/:jobId',            authMiddleware,                controller.processJob);
router.get('/processing-status/:jobId',   authMiddleware,                controller.getStatus);
router.get('/categories',                 authMiddleware,                controller.listProductCategories);
router.get('/',                           authMiddleware,                controller.listProducts);

module.exports = router;
