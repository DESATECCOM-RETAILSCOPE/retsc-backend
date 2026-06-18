const express        = require('express');
const multer         = require('multer');
const path           = require('path');
const fs             = require('fs');
const router         = express.Router();
const controller     = require('../controllers/skuController');
const authMiddleware = require('../middlewares/authMiddleware');

const UPLOADS_TEMP = path.join(__dirname, '..', '..', 'uploads-temp');
fs.mkdirSync(UPLOADS_TEMP, { recursive: true });

const excelUpload = multer({
  dest: UPLOADS_TEMP,
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo se aceptan archivos .xlsx o .xls'), ok);
  },
}).single('file');

// POST /api/skus/upload-excel
router.post('/upload-excel', authMiddleware, excelUpload, controller.uploadSkuExcel);

module.exports = router;
