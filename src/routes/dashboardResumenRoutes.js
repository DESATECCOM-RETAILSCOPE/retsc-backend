// Rutas del Dashboard web (Parte B), pantalla 1: Resumen.
// Montadas desde routes/dashboardRoutes.js en /api/dashboard/resumen (requieren sesión).
// precision-modelo y lectura-ocr son solo para ADMIN_DTC (decisión del 5 de octubre):
// un cliente recibe 403 aunque escriba la URL a mano.
// Parámetros de filtro: ver DashEnterpriseId, DashCategory, etc. en dashboardCumplimientoRoutes.js.

const express     = require('express');
const router      = express.Router();
const controller  = require('../controllers/dashboardResumenController');
const requireRole = require('../middlewares/requireRole');
const { ROLES }   = require('../config/roles');

const soloDtc = requireRole(ROLES.ADMIN_DTC);

/**
 * @swagger
 * /api/dashboard/resumen/cumplimiento-promedio:
 *   get:
 *     summary: KPI de cumplimiento promedio, con variación frente al período anterior
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashChain'
 *       - $ref: '#/components/parameters/DashFormat'
 *       - $ref: '#/components/parameters/DashDesde'
 *       - $ref: '#/components/parameters/DashHasta'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: { cumplimiento_promedio, visitas, variacion_pts, anterior_cumplimiento_promedio, anterior_visitas, anterior_desde, anterior_hasta }" }
 */
router.get('/cumplimiento-promedio', controller.cumplimientoPromedio);

/**
 * @swagger
 * /api/dashboard/resumen/productos:
 *   get:
 *     summary: KPI de productos registrados (catálogo global) y porcentaje de propios
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: { total, propios, competencia, pct_propios }" }
 */
router.get('/productos', controller.productos);

/**
 * @swagger
 * /api/dashboard/resumen/cobertura-fotos:
 *   get:
 *     summary: KPI de cobertura de foto del catálogo (SKUs activos con foto)
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: { total, con_foto, sin_foto, pct_cobertura }" }
 */
router.get('/cobertura-fotos', controller.coberturaFotos);

/**
 * @swagger
 * /api/dashboard/resumen/precision-modelo:
 *   get:
 *     summary: KPI de precisión del modelo, última iteración (solo ADMIN_DTC)
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: { precision_pct, recall_pct, map_pct, categorias, categoria, trained_at, last_publish_name, status }" }
 *       403: { description: El usuario no es ADMIN_DTC }
 */
router.get('/precision-modelo', soloDtc, controller.precisionModelo);

/**
 * @swagger
 * /api/dashboard/resumen/lectura-ocr:
 *   get:
 *     summary: KPI de tasa de lectura OCR, nivel 1 (solo ADMIN_DTC)
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashDesde'
 *       - $ref: '#/components/parameters/DashHasta'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: { total_detecciones, con_texto_leido, texto_leido_con_match, pct_tasa_lectura, pct_match_sobre_texto_leido }" }
 *       403: { description: El usuario no es ADMIN_DTC }
 */
router.get('/lectura-ocr', soloDtc, controller.lecturaOcr);

module.exports = router;
