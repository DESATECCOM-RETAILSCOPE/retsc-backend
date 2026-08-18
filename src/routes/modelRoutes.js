// Rutas de listado de modelos de detección (Issue 8.5 — reducido 2026-08-03).
// Prefijo en app.js: /api/models  (montado con authMiddleware)
//
// RETIRADO por decisión de jefatura: /category/:categoryId/can-retrain, POST /category/:id/
// retrain, POST /:modelId/complete, POST /:modelId/approve, POST /:modelId/reject,
// POST /category/:id/rollback/:version — todo el ciclo de re-entrenamiento/aprobación manual.
// Ver modelController.js y modelVersioningService.js para el detalle de qué se eliminó y
// qué se preservó para el cableado del flujo automático (spec v1.4).
//
// Gestión restringida por rol. Roles permitidos configurables por env
// MODEL_MANAGER_ROLES (CSV); default: 'Admin'.

const express     = require('express');
const router      = express.Router();
const requireRole = require('../middlewares/requireRole');
const c           = require('../controllers/modelController');

const MANAGER_ROLES = (process.env.MODEL_MANAGER_ROLES || 'ADMIN,ADMIN_DTC')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const canManage = requireRole(...MANAGER_ROLES);

/**
 * @swagger
 * /api/models:
 *   get:
 *     summary: Listado global de modelos de detección (todas las categorías y versiones)
 *     tags: [Models]
 *     security:
 *       - bearerAuth: []
 *     description: Montaje patrón 1 — authMiddleware global en app.js sobre /api/models,
 *       más requireRole(MODEL_MANAGER_ROLES) inline (canManage) en esta ruta. Alimenta el
 *       ítem "Modelos de detección" del menú ADMIN_DTC (F4). No hay colisión de ruta con
 *       /category/:categoryId (path distinto) ni con ningún GET /:modelId (no existe).
 *     responses:
 *       200:
 *         description: Lista de modelos (todas las categorías/versiones, activos e inactivos)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 models: { type: array, items: { type: object } }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol MODEL_MANAGER_ROLES (default ADMIN,ADMIN_DTC)
 */
router.get('/',                     canManage, c.listAll);
router.get('/category/:categoryId', canManage, c.listVersions);

module.exports = router;
