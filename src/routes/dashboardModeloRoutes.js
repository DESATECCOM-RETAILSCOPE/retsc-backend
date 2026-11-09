// Rutas del Dashboard web (Parte B), pantalla 4: Modelo IA & OCR.
// Montadas desde routes/dashboardRoutes.js en /api/dashboard/modelo (requieren sesión).
// Solo ADMIN_DTC (decisión del 5 de octubre): un cliente recibe 403 aunque escriba
// la URL a mano. Filtro: solo categoría.

const express     = require('express');
const router      = express.Router();
const controller  = require('../controllers/dashboardModeloController');
const requireRole = require('../middlewares/requireRole');
const { ROLES }   = require('../config/roles');

router.use(requireRole(ROLES.ADMIN_DTC));

/**
 * @swagger
 * /api/dashboard/modelo/iteracion:
 *   get:
 *     summary: Última iteración del modelo por categoría (anexo 8). Solo ADMIN_DTC
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: [{ categoria, model_version, trained_at, last_publish_name, precision_pct, recall_pct, map_pct, status, estado }]" }
 *       403: { description: El usuario no es ADMIN_DTC }
 */
router.get('/iteracion', controller.iteracion);

/**
 * @swagger
 * /api/dashboard/modelo/ocr:
 *   get:
 *     summary: OCR nivel 1 sobre todas las empresas y todo el período (anexo 9). Solo ADMIN_DTC
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: { total_detecciones, con_texto_leido, texto_leido_con_match, texto_leido_sin_match, pct_tasa_lectura, pct_match_sobre_texto_leido, pct_sin_match }" }
 *       403: { description: El usuario no es ADMIN_DTC }
 */
router.get('/ocr', controller.ocr);

module.exports = router;
