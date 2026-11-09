// Rutas del Dashboard web (Parte B), pantalla 3: Catálogo & Fotos.
// Montadas desde routes/dashboardRoutes.js en /api/dashboard/catalogo (requieren sesión).
// Filtros: empresa (solo ADMIN_DTC, con enterpriseId) y categoría. El catálogo es
// global: la empresa solo define cuáles SKUs son "propios" y de quién son las fotos.

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/dashboardCatalogoController');

/**
 * @swagger
 * /api/dashboard/catalogo/productos:
 *   get:
 *     summary: SKUs activos por categoría, propios y competencia (anexo 5)
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: [{ category_id, categoria, total, propios, competencia, pct_propios }]" }
 */
router.get('/productos', controller.productos);

/**
 * @swagger
 * /api/dashboard/catalogo/fotos-producto:
 *   get:
 *     summary: Cobertura de foto por categoría (anexo 6B)
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: [{ category_id, categoria, total, con_foto, sin_foto, pct_cobertura }]" }
 */
router.get('/fotos-producto', controller.fotosProducto);

/**
 * @swagger
 * /api/dashboard/catalogo/fotos-producto-detalle:
 *   get:
 *     summary: Estados del log de carga de fotos de producto (anexo 6A, soporte)
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: [{ process_status, ocr_status, embeddings_status, cantidad }]" }
 */
router.get('/fotos-producto-detalle', controller.fotosProductoDetalle);

/**
 * @swagger
 * /api/dashboard/catalogo/fotos-gondola:
 *   get:
 *     summary: Fotos de góndola por categoría, entrenamiento vs. visitas (anexo 7)
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *       - $ref: '#/components/parameters/DashCategory'
 *       - $ref: '#/components/parameters/DashExport'
 *     responses:
 *       200: { description: "data: [{ category_id, categoria, fotos_entrenamiento, entrenamiento_aprobadas, fotos_visita }]" }
 */
router.get('/fotos-gondola', controller.fotosGondola);

module.exports = router;
