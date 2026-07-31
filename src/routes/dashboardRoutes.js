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
 *                 trends:
 *                   type: object
 *                   description: >
 *                     Tendencia de cada uno de los 4 números de arriba (Issue B7 follow-up).
 *                     Requiere la tabla RETSC_LOG_DASHBOARD_SNAPSHOTS (migración 008, se
 *                     aplica manualmente vía SSMS) — mientras no exista, deltaPct siempre
 *                     viene null y series trae solo el valor de hoy (1 elemento).
 *                   properties:
 *                     productCards:      { $ref: '#/components/schemas/DashboardTrend' }
 *                     productPhotos:     { $ref: '#/components/schemas/DashboardTrend' }
 *                     activeAssortments: { $ref: '#/components/schemas/DashboardTrend' }
 *                     analysesDone:      { $ref: '#/components/schemas/DashboardTrend' }
 *                 productsByCategory:
 *                   type: array
 *                   description: Todas las categorías con al menos 1 producto en scope, sin recortar — el frontend decide el top N.
 *                   items:
 *                     type: object
 *                     properties:
 *                       categoryId: { type: integer, nullable: true }
 *                       categoryDsc: { type: string, example: "Bebidas" }
 *                       count: { type: integer }
 *                 modelPrecision:
 *                   type: object
 *                   description: >
 *                     Precisión promedio de los modelos IA activos en scope. Depende de la
 *                     migración 006 (precision_score en RETSC_AI_DETECTION_MODELS),
 *                     verificada como NO aplicada — mientras tanto avgPct/deltaPct vienen
 *                     null y series vacío, pero el objeto siempre viaja completo.
 *                   properties:
 *                     avgPct: { type: number, nullable: true, example: 92.6 }
 *                     deltaPct: { type: number, nullable: true, example: 3.4 }
 *                     series:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           date: { type: string, example: "2026-06-01" }
 *                           value: { type: number, example: 78 }
 *                 recentActivity:
 *                   type: array
 *                   description: Hasta 10 eventos más recientes en scope, combinados de 5 fuentes distintas.
 *                   items:
 *                     type: object
 *                     properties:
 *                       type: { type: string, enum: [SKU_IMAGES_UPLOADED, SHELF_PHOTO_UPLOADED, ASSORTMENT_UPDATED, MODEL_TRAINED, PHOTO_APPROVED] }
 *                       title: { type: string, example: "Se cargaron 120 imágenes" }
 *                       meta: { type: string, nullable: true, example: "Categoría: Bebidas" }
 *                       occurredAt: { type: string, format: date-time }
 *       401:
 *         description: Sin token, o token expirado
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     DashboardTrend:
 *       type: object
 *       properties:
 *         deltaPct: { type: number, nullable: true, description: "null si no hay snapshot de referencia, o si el valor de referencia es 0" }
 *         series:
 *           type: array
 *           items: { type: integer }
 *           description: "Hasta 8 valores, del más viejo al más nuevo (incluye hoy). 1 elemento o vacío si no hay historial todavía."
 */
router.get('/', controller.getDashboard);

module.exports = router;
