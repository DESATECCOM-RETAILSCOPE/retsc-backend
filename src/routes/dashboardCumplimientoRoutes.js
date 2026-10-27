// Rutas del Dashboard web (Parte B), pantalla 2: Cumplimiento.
// Montadas desde routes/dashboardRoutes.js en /api/dashboard/cumplimiento, que a su
// vez se monta en app.js con authMiddleware global: todas requieren sesión.
// La empresa se resuelve en utils/dashboardFilters (ADMIN_DTC la elige con
// enterpriseId; un cliente ve siempre la suya y recibe 403 si pide otra).

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/dashboardCumplimientoController');

/**
 * @swagger
 * components:
 *   parameters:
 *     DashEnterpriseId:
 *       in: query
 *       name: enterpriseId
 *       schema: { type: integer }
 *       description: Solo ADMIN_DTC (obligatorio para ese rol). Un cliente que pide otra empresa recibe 403.
 *     DashCategory:
 *       in: query
 *       name: category
 *       schema: { type: integer }
 *       description: Categoría DTC. Vacío = todas.
 *     DashChain:
 *       in: query
 *       name: chain
 *       schema: { type: integer }
 *       description: Supermarketchain_id. Vacío = todas las cadenas.
 *     DashFormat:
 *       in: query
 *       name: format
 *       schema: { type: string }
 *       description: Formato de tienda (snapshot). Vacío = todos.
 *     DashDesde:
 *       in: query
 *       name: desde
 *       schema: { type: string, format: date }
 *       description: AAAA-MM-DD. Por defecto, hoy menos 89 días.
 *     DashHasta:
 *       in: query
 *       name: hasta
 *       schema: { type: string, format: date }
 *       description: AAAA-MM-DD, inclusive. Por defecto, hoy.
 *     DashExport:
 *       in: query
 *       name: export
 *       schema: { type: string, enum: [csv] }
 *       description: Con export=csv descarga el CSV de la tarjeta (separador ";", UTF-8 con BOM).
 */

/**
 * @swagger
 * /api/dashboard/cumplimiento/tendencia:
 *   get:
 *     summary: Tendencia de cumplimiento por día, semana o mes (anexo 1)
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
 *       - in: query
 *         name: agrupar
 *         schema: { type: string, enum: [dia, semana, mes], default: semana }
 *         description: semana agrupa desde el lunes.
 *     responses:
 *       200: { description: "data: [{ periodo, visitas, cumplimiento_promedio, cumplimiento_minimo, cumplimiento_maximo }]" }
 *       400: { description: Filtro inválido }
 *       403: { description: Un cliente pidió otra empresa }
 */
router.get('/tendencia', controller.tendencia);

/**
 * @swagger
 * /api/dashboard/cumplimiento/visitas:
 *   get:
 *     summary: Tabla por visita, de la más reciente a la más antigua (anexo 1)
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
 *       200: { description: "data: [{ fecha_visita, visit_id, tienda, cumplimiento_pct, productos_esperados, productos_detectados, faltantes, ... }]" }
 */
router.get('/visitas', controller.visitas);

/**
 * @swagger
 * /api/dashboard/cumplimiento/ranking-tiendas:
 *   get:
 *     summary: Ranking por tienda, con cadena y formato (anexo 2)
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
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *         description: El Resumen usa limit=5.
 *     responses:
 *       200: { description: "data: [{ tienda, cadena, formato, visitas, cumplimiento_promedio, faltantes, prioritarios_faltantes }]" }
 */
router.get('/ranking-tiendas', controller.rankingTiendas);

/**
 * @swagger
 * /api/dashboard/cumplimiento/ranking-cadenas:
 *   get:
 *     summary: Ranking por cadena + formato (anexo 2)
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
 *       200: { description: "data: [{ cadena, formato, visitas, cumplimiento_promedio, faltantes, prioritarios_faltantes }]" }
 */
router.get('/ranking-cadenas', controller.rankingCadenas);

/**
 * @swagger
 * /api/dashboard/cumplimiento/exceso-prioritarios:
 *   get:
 *     summary: Evolución de exceso y prioritarios faltantes, % sobre esperados (anexo 3)
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
 *       200: { description: "data: [{ fecha_visita, visit_id, productos_esperados, pct_exceso_fuera_surtido, pct_exceso_no_autorizado, pct_prioritarios_faltantes }]" }
 */
router.get('/exceso-prioritarios', controller.excesoPrioritarios);

/**
 * @swagger
 * /api/dashboard/cumplimiento/composicion:
 *   get:
 *     summary: Composición en góndola del período (anexo 4)
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
 *       - in: query
 *         name: por
 *         schema: { type: string, enum: [marca, fabricante, subcategoria, presentacion], default: marca }
 *     responses:
 *       200: { description: "data: [{ valor, cantidad, porcentaje }], ordenado de mayor a menor" }
 */
router.get('/composicion', controller.composicion);

module.exports = router;
