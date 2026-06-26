// Rutas de gestión de versiones de modelos (Issue 8.5).
// Prefijo en app.js: /api/models  (montado con authMiddleware)
//
// Gestión restringida por rol. Roles permitidos configurables por env
// MODEL_MANAGER_ROLES (CSV); default: 'Admin'.

const express     = require('express');
const router      = express.Router();
const requireRole = require('../middlewares/requireRole');
const c           = require('../controllers/modelController');

const MANAGER_ROLES = (process.env.MODEL_MANAGER_ROLES || 'Admin')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const canManage = requireRole(...MANAGER_ROLES);

// Lectura
router.get('/category/:categoryId',             canManage, c.listVersions);
router.get('/category/:categoryId/can-retrain', canManage, c.canRetrain);

// Ciclo de vida
router.post('/category/:categoryId/retrain',              canManage, c.retrain);
router.post('/category/:categoryId/rollback/:version',    canManage, c.rollback);
router.post('/:modelId/complete', canManage, c.complete);
router.post('/:modelId/approve',  canManage, c.approve);
router.post('/:modelId/reject',   canManage, c.reject);

module.exports = router;
