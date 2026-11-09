// Rutas del Dashboard web (Parte B): opciones de los filtros.
// Montada desde routes/dashboardRoutes.js en /api/dashboard/opciones (requiere sesión).

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/dashboardOpcionesController');

/**
 * @swagger
 * /api/dashboard/opciones:
 *   get:
 *     summary: Opciones de los filtros del dashboard (categorías, cadenas y formatos con datos)
 *     tags: [Dashboard web]
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - $ref: '#/components/parameters/DashEnterpriseId'
 *     responses:
 *       200: { description: "data: { categorias: [{ id, nombre }], cadenas: [{ id, nombre }], formatos: [string] }" }
 *       400: { description: ADMIN_DTC sin empresa elegida }
 *       403: { description: Un cliente pidió otra empresa }
 */
router.get('/', controller.opciones);

module.exports = router;
