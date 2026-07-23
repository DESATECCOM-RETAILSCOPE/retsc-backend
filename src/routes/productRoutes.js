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

/**
 * @swagger
 * components:
 *   schemas:
 *     Product:
 *       type: object
 *       properties:
 *         productId: { type: integer }
 *         skuId: { type: integer }
 *         gtin: { type: string, example: "7702006001014" }
 *         description: { type: string }
 *         categoryId: { type: integer, description: "FK numérica al árbol oficial RETSC_OP_CATEGORIES — NO es lo que acepta el filtro ?categoryId de este mismo endpoint (ver más abajo)." }
 *         categoryName: { type: string }
 *         clientCategory: { type: string, nullable: true }
 *         clientSubcategory: { type: string, nullable: true }
 *         brand: { type: string, nullable: true }
 *         supplier: { type: string, nullable: true }
 *         volume: { type: number, nullable: true }
 *         relevantFeature: { type: string, nullable: true }
 *         status: { type: string, example: ACTIVE }
 *         primaryImage: { type: string, nullable: true }
 */

/**
 * @swagger
 * /api/products:
 *   get:
 *     summary: Lista los productos (SKUs) de la empresa autenticada, con paginación y filtros
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     description: Montada con auth por-ruta (authMiddleware inline en cada línea de este
 *       router, junto con multer en las rutas de upload) — patrón 3 de los 3 de montaje de
 *       este repo. `enterpriseId` se toma del JWT, no de un parámetro.
 *     parameters:
 *       - in: query
 *         name: categoryId
 *         schema: { type: string }
 *         description: >
 *           ⚠️ FOOTGUN — a pesar del nombre, este parámetro filtra por IGUALDAD DE TEXTO
 *           EXACTO contra `client_category` (la categoría propia del cliente, tal como viene
 *           en su Excel de carga) — NO es el `categoryId` numérico que devuelve cada producto
 *           en la respuesta de este mismo endpoint. Usar siempre el TEXTO que devuelve
 *           `GET /api/products/categories` (campo `categoryDsc`), nunca el ID numérico.
 *           Ejemplo real verificado: `categoryId=DESODORANTES CORPORALES` → filtra correctamente;
 *           `categoryId=38` (el categoryId numérico real de esos mismos productos) → 0 resultados.
 *         example: "DESODORANTES CORPORALES"
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Búsqueda libre contra EAN o descripción del producto (LIKE).
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Página de productos
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 products:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Product' }
 *                 total: { type: integer, description: "Total de filas que matchean el filtro, no solo las de esta página." }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *       401:
 *         description: Sin token, o token expirado (code TOKEN_EXPIRED)
 */
router.get('/',                           authMiddleware,                controller.listProducts);

module.exports = router;
