// Rutas de entrenamiento de modelos Custom Vision (Issue 8.3).
// Prefijo en app.js: /api/training  (montado con authMiddleware)
//
// Restringido por rol. Roles permitidos configurables por env TRAINING_ADMIN_ROLES (CSV);
// default: 'Admin'. Mismo patrón que modelRoutes.js (Issue 8.5).

const express     = require('express');
const router      = express.Router();
const requireRole = require('../middlewares/requireRole');
const c           = require('../controllers/trainingController');

const ADMIN_ROLES = (process.env.TRAINING_ADMIN_ROLES || 'ADMIN,ADMIN_DTC')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const canTrain = requireRole(...ADMIN_ROLES);

router.post('/models/:categoryId/train', canTrain, c.train);

module.exports = router;
