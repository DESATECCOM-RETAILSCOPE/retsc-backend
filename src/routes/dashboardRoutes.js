// Rutas del dashboard (Issue B7).
// Prefijo en app.js: /api/dashboard (montado con authMiddleware global).
// Cualquier usuario autenticado puede pedir SU dashboard — el scope (global vs. su
// empresa) se resuelve por rol dentro de dashboardService.js, no acá.

const express    = require('express');
const router     = express.Router();

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
router.use('/cumplimiento', require('./dashboardCumplimientoRoutes'));
router.use('/opciones', require('./dashboardOpcionesRoutes'));
router.use('/resumen', require('./dashboardResumenRoutes'));
router.use('/catalogo', require('./dashboardCatalogoRoutes'));

module.exports = router;
