// Rutas de revisión de anotaciones (Issue 7.5).
// Prefijo en app.js: /api/annotations  (montado con authMiddleware)
//
// Acciones de validación restringidas por rol. Roles permitidos configurables por
// env ANNOTATION_VALIDATOR_ROLES (CSV); default: 'ADMIN,ADMIN_DTC'.
// (El rol 'Supervisor' que este default usaba antes fue eliminado del catálogo
// — ver scripts/remove-legacy-roles.js. requireRole normaliza mayúsculas.)
// Listar y consultar readiness solo requieren estar autenticado.

const express      = require('express');
const router       = express.Router();
const requireRole  = require('../middlewares/requireRole');
const c            = require('../controllers/annotationController');

// Roles autorizados para aprobar/corregir/rechazar.
const VALIDATOR_ROLES = (process.env.ANNOTATION_VALIDATOR_ROLES || 'ADMIN,ADMIN_DTC')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const canValidate = requireRole(...VALIDATOR_ROLES);

// Lectura (cualquier usuario autenticado) — primero las rutas /photo para evitar
// que ':id' capture 'photo'.
router.get('/photo/:photoId',            c.listByPhoto);
router.get('/photo/:photoId/readiness',  c.readiness);

// Review queue (Issue 8.2 + menú por rol 2026-07-25) — "Anotaciones" (ADMIN_DTC) y
// "Revisar cajitas" (ADMIN). A diferencia de /photo/:photoId de arriba (abierta a
// cualquier autenticado), esta va gateada por canValidate: es la cola de trabajo del
// revisor, no una consulta de solo-lectura general.
// '/photos' (plural) no colisiona con '/photo/:photoId' (singular, distinto segmento
// literal) ni con las rutas ':id' de más abajo (distinta cantidad de segmentos) —
// verificado levantando el router, no solo por inspección.
router.get('/photos',                        canValidate, c.listPhotos);
router.get('/photos/:photoId',               canValidate, c.getPhotoDetail);
router.patch('/photos/:photoId/approve',     canValidate, c.approvePhoto);

// Acciones de validación (solo roles autorizados)
router.patch('/:id/approve', canValidate, c.approve);  // APROBAR
router.patch('/:id',         canValidate, c.correct);  // CORREGIR
router.delete('/:id',        canValidate, c.reject);   // RECHAZAR

module.exports = router;
