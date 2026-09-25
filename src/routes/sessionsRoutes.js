// Rutas del endpoint de resultados de visita (Paso 6, guía "Fotos de Visita" v1.9).
// Prefijo en app.js: /api/sessions  (montado con authMiddleware)
//
// Literal de la guía (sección 8.3): "GET /api/sessions/:id/results" — :id es el Visit_id.
// Sin restricción de rol adicional más allá de estar autenticado: el scoping por
// enterprise (no ver resultados de otro enterprise) se aplica en el controller, no aquí,
// porque también deben poder verlo los roles móviles que hicieron la visita
// (AUDITOR_CAMPO/EJECUTIVO_CAMPO), no solo ADMIN/GERENCIA.

const express = require('express');
const router  = express.Router();
const c       = require('../controllers/sessionsController');
const reportController = require('../controllers/reportController');

/**
 * @swagger
 * /api/sessions/{id}/results:
 *   get:
 *     summary: Resultados de una visita (Paso 6, guía Fotos de Visita v1.9)
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       El id de la URL es el Visit_id devuelto al abrir la visita (Paso 0) — la guía lo
 *       llama "session_id" en la URL, pero internamente todo se resuelve contra
 *       RETSC_EX_VISIT, no existe una tabla "session" separada. Scoping — ADMIN_DTC ve
 *       cualquier visita; los demás roles (incluyendo AUDITOR_CAMPO/EJECUTIVO_CAMPO, no solo
 *       ADMIN/GERENCIA) solo ven visitas de su propio enterprise.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Visit_id
 *     responses:
 *       200:
 *         description: Share de góndola, faltantes del surtido y productos sin identificar
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Nombres literales en español (contrato acordado con el mobile
 *                 en la guía), no camelCase.
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 visit_id: { type: integer }
 *                 share_de_gondola:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       marca:  { type: string }
 *                       conteo: { type: integer }
 *                       share:  { type: number, format: float }
 *                 faltantes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sku_id:   { type: integer }
 *                       producto: { type: string }
 *                 sin_identificar: { type: integer, description: "Conteo de detecciones sin Sku_id asignado" }
 *       400:
 *         description: Visit ID inválido
 *       403:
 *         description: La visita pertenece a otro enterprise
 *       404:
 *         description: Visita no encontrada (ERR_VISITA_NO_ENCONTRADA)
 */
router.get('/:id/results', c.getResults);

/**
 * @swagger
 * /api/sessions/{id}/compliance/{categoryId}:
 *   get:
 *     summary: Cumplimiento de surtido de una visita/categoría (María, 2026-09)
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Se calcula BAJO DEMANDA en cada llamada — inserta una fila nueva en
 *       RETSC_EX_ASSORTMENT_COMPLIANCE (histórico, no upsert). Supermarketchain_id/Format
 *       salen del Retailer de la visita; el desglose "propio vs. competencia" depende de
 *       RETSC_OP_ENTERPRISE.supplier_name (migración 011) — si ese enterprise no lo tiene
 *       cargado, en_exceso_fuera_surtido queda subestimado (se loguea una advertencia,
 *       nunca falla la respuesta). Mismo scoping por enterprise que GET /results.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Visit_id
 *       - in: path
 *         name: categoryId
 *         required: true
 *         schema: { type: integer }
 *         description: RETSC_OP_SKUS.selected_category_id de la categoría a reportar
 *     responses:
 *       200:
 *         description: Cumplimiento calculado + desglose + detalle de faltantes/exceso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 compliance:
 *                   type: object
 *                   description: Fila insertada en RETSC_EX_ASSORTMENT_COMPLIANCE
 *                   properties:
 *                     compliance_id:           { type: integer }
 *                     productos_esperados:     { type: integer }
 *                     productos_detectados:    { type: integer }
 *                     faltantes:               { type: integer }
 *                     en_exceso_fuera_surtido: { type: integer }
 *                     en_exceso_no_autorizado: { type: integer }
 *                     prioritarios_faltantes:  { type: integer }
 *                     cumplimiento_pct:        { type: number, format: float }
 *                     calculado_en:            { type: string, format: date-time }
 *                 share:
 *                   type: array
 *                   description: "Composición en góndola: una fila por (dimension, valor)"
 *                   items:
 *                     type: object
 *                     properties:
 *                       dimension: { type: string, enum: [marca, fabricante, subcategoria, presentacion] }
 *                       valor:     { type: string }
 *                       cantidad:  { type: integer }
 *                 faltantes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sku_id:        { type: integer }
 *                       Product_dsc:   { type: string }
 *                       image_url:     { type: string, nullable: true }
 *                       Brand:         { type: string, nullable: true }
 *                       es_prioritario: { type: boolean }
 *                 enExceso:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sku_id:      { type: integer }
 *                       Product_dsc: { type: string }
 *                       image_url:   { type: string, nullable: true }
 *                       Brand:       { type: string, nullable: true }
 *                       motivo:      { type: string, enum: [FUERA_DE_SURTIDO, NO_AUTORIZADO] }
 *       400:
 *         description: Visit ID o Category ID inválido
 *       403:
 *         description: La visita pertenece a otro enterprise
 *       404:
 *         description: Visita, retailer o enterprise no encontrado
 */
router.get('/:id/compliance/:categoryId', c.getCompliance);

/**
 * @swagger
 * /api/sessions/{id}/photos:
 *   get:
 *     summary: Fotos de góndola tomadas en una visita ("Ver fotos de la visita")
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Fotos de RETSC_EX_SHELFPHOTO para la visita, con su URL_blob ya firmada (SAS de
 *       lectura de 60 min — el storage account no permite lectura pública anónima, ver
 *       blobStorageService.signBlobUrl). Mismo scoping que /results y /compliance.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Visit_id
 *       - in: query
 *         name: categoryId
 *         required: false
 *         schema: { type: integer }
 *         description: Si se manda, filtra solo las fotos de esa categoría.
 *     responses:
 *       200:
 *         description: Lista de fotos de la visita
 *       400:
 *         description: Visit ID o Category ID inválido
 *       403:
 *         description: La visita pertenece a otro enterprise
 *       404:
 *         description: Visita no encontrada
 */
router.get('/:id/photos', c.getVisitPhotos);

/**
 * @swagger
 * /api/sessions/{id}/compliance/{categoryId}/report-token:
 *   get:
 *     summary: Token de corta duración (5 min) para abrir el PDF de cumplimiento de surtido
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       El mobile usa este token para armar la URL de GET /api/reports/compliance.pdf, que
 *       se abre en el navegador del sistema (sin header Authorization). Mismo scoping que
 *       /compliance.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Visit_id
 *       - in: path
 *         name: categoryId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Token de reporte
 *       400:
 *         description: Visit ID o Category ID inválido
 *       403:
 *         description: La visita pertenece a otro enterprise
 *       404:
 *         description: Visita no encontrada
 */
router.get('/:id/compliance/:categoryId/report-token', reportController.getReportToken);

module.exports = router;
