// Rutas de GET /api/readiness — ver processReadinessService.js para el contexto completo.
// Prefijo en app.js: /api/readiness (montado con authMiddleware, sin gate de rol adicional:
// lo usan los mismos roles móviles que capturan fotos, AUDITOR_CAMPO/EJECUTIVO_CAMPO).

const express = require('express');
const router = express.Router();
const c = require('../controllers/processReadinessController');

/**
 * @swagger
 * /api/readiness:
 *   get:
 *     summary: ¿Puede el usuario entrar al módulo de captura/proceso para esta categoría en este punto de venta?
 *     tags: [Readiness]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Centraliza las condiciones que assortmentComplianceRepo.calculateAndSave() necesita
 *       para no fallar — construido tras el crash de NULL en cumplimiento_pct (Enterprise_id=2,
 *       2026-10-23: nunca se cargó surtido para esa empresa). El mobile lo llama ANTES de dejar
 *       entrar a ShelfCapture/CameraCapture para esa categoría (VisitCaptureScreen, al tocar
 *       "Tomar Fotos..."), para avisar con un mensaje claro en vez de dejar tomar fotos que
 *       después no se van a poder procesar.
 *     parameters:
 *       - in: query
 *         name: retailerId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: categoryId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Resultado del chequeo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 ready: { type: boolean }
 *                 blockers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       code:    { type: string, enum: [RETAILER_NOT_FOUND, RETAILER_MISSING_CHAIN_FORMAT, NO_DETECTION_MODEL, NO_ASSORTMENT] }
 *                       message: { type: string }
 *       400:
 *         description: retailerId o categoryId faltante/no numérico
 *       401:
 *         description: Sin token, o token expirado
 */
router.get('/', c.checkReadiness);

module.exports = router;
