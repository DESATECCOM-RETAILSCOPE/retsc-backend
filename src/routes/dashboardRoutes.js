// Rutas del dashboard (Issue B7).
// Prefijo en app.js: /api/dashboard (montado con authMiddleware global).
// Cualquier usuario autenticado puede pedir SU dashboard — el scope (global vs. su
// empresa) se resuelve por rol dentro de dashboardService.js, no acá.

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/dashboardController');

/**
 * @swagger
 * /api/dashboard:
 *   get:
 *     summary: Métricas reales del dashboard, escopeadas por rol
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     description: Montada con auth GLOBAL en app.js (authMiddleware al montar el
 *       router). ADMIN_DTC ve la plataforma completa; ADMIN y GERENCIA ven solo su
 *       propia empresa (req.user.enterpriseId). Ver dashboardRepo.js para el origen
 *       real de cada métrica y por qué se eligió esa tabla.
 *     responses:
 *       200:
 *         description: Métricas del dashboard
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 productCards: { type: integer, description: "SKUs cargados en scope" }
 *                 productPhotos: { type: integer, description: "Imágenes de SKU subidas en scope" }
 *                 activeAssortments: { type: integer, description: "Filas de RETSC_OP_ASSORTMENT en scope (tabla real, hoy vacía en producción)" }
 *                 analysesDone: { type: integer, description: "SKUs con image_status='COGNITIVELY_PROCESSED' en scope" }
 *       401:
 *         description: Sin token, o token expirado
 */
router.get('/', controller.getDashboard);

module.exports = router;
