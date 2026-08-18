// Rutas para RETSC_EX_VISIT (Paso 0 de la guía "Fotos de Visita" v1.9).
// Prefijo en app.js: /api/visits  (montado con authMiddleware)
//
// Abrir/cerrar visitas es una acción de la app móvil — roles configurables por env
// VISIT_ROLES (CSV). Default incluye los dos roles móviles (AUDITOR_CAMPO, EJECUTIVO_CAMPO)
// más ADMIN/ADMIN_DTC (soporte/pruebas), mismo patrón que SHELF_UPLOAD_ROLES.

const express     = require('express');
const router      = express.Router();
const requireRole = require('../middlewares/requireRole');
const c           = require('../controllers/visitController');

const VISIT_ROLES = (process.env.VISIT_ROLES || 'AUDITOR CAMPO,EJECUTIVO CAMPO,ADMIN,ADMIN_DTC')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const canOperate = requireRole(...VISIT_ROLES);

/**
 * @swagger
 * /api/visits:
 *   post:
 *     summary: Abre una visita (Paso 0, guía Fotos de Visita v1.9)
 *     tags: [Visits]
 *     security:
 *       - bearerAuth: []
 *     description: Enterprise_id sale del JWT, no del body. Devuelve Visit_id — el mobile
 *       lo reusa en todos los pasos siguientes (subida de fotos, cierre, resultados).
 *     responses:
 *       201:
 *         description: Visita abierta
 *       409:
 *         description: El usuario ya tiene una visita abierta
 */
router.post('/',              canOperate, c.open);
router.get('/me/open',         canOperate, c.getMyOpen);
router.get('/:id',             canOperate, c.getOne);
router.patch('/:id/close',     canOperate, c.close);

module.exports = router;
