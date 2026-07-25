const express        = require('express');
const multer         = require('multer');
const path           = require('path');
const fs             = require('fs');
const router         = express.Router();
const controller     = require('../controllers/skuController');
const authMiddleware = require('../middlewares/authMiddleware');
const requireRole    = require('../middlewares/requireRole');
const { ROLES }      = require('../config/roles');

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

/**
 * @swagger
 * /api/skus/global:
 *   get:
 *     summary: Listado global paginado del catálogo de SKUs (todas las empresas)
 *     tags: [SKUs]
 *     security:
 *       - bearerAuth: []
 *     description: Montaje patrón 3 — este router no tiene auth global en app.js, cada ruta
 *       la aplica inline. authMiddleware + requireRole(ADMIN_DTC) inline en esta ruta —
 *       un ADMIN de empresa no debe ver el catálogo completo cross-empresa (mismo criterio
 *       que GET /api/enterprises, Issue B3). Alimenta el ítem "SKUs globales" del menú
 *       ADMIN_DTC (F4). Único GET del router — no hay ninguna otra ruta con parámetro con
 *       la que pueda colisionar.
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Busca por EAN o Product_dsc (LIKE, no exacto).
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Página de SKUs + total
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 skus: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero no es ADMIN_DTC
 */
router.get('/global', authMiddleware, requireRole(ROLES.ADMIN_DTC), controller.listGlobalSkus);

module.exports = router;
