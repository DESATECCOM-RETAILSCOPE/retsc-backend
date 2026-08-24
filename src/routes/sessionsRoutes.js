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

module.exports = router;
