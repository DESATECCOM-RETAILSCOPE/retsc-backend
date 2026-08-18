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

router.get('/:id/results', c.getResults);

module.exports = router;
