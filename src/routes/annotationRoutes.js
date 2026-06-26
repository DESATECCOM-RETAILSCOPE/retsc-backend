// Rutas de revisión de anotaciones (Issue 7.5).
// Prefijo en app.js: /api/annotations  (montado con authMiddleware)
//
// Acciones de validación restringidas por rol. Roles permitidos configurables por
// env ANNOTATION_VALIDATOR_ROLES (CSV); default: 'Admin,Supervisor'.
// Listar y consultar readiness solo requieren estar autenticado.

const express      = require('express');
const router       = express.Router();
const requireRole  = require('../middlewares/requireRole');
const c            = require('../controllers/annotationController');

// Roles autorizados para aprobar/corregir/rechazar.
const VALIDATOR_ROLES = (process.env.ANNOTATION_VALIDATOR_ROLES || 'Admin,Supervisor')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const canValidate = requireRole(...VALIDATOR_ROLES);

// Lectura (cualquier usuario autenticado) — primero las rutas /photo para evitar
// que ':id' capture 'photo'.
router.get('/photo/:photoId',            c.listByPhoto);
router.get('/photo/:photoId/readiness',  c.readiness);

// Acciones de validación (solo roles autorizados)
router.patch('/:id/approve', canValidate, c.approve);  // APROBAR
router.patch('/:id',         canValidate, c.correct);  // CORREGIR
router.delete('/:id',        canValidate, c.reject);   // RECHAZAR

module.exports = router;
