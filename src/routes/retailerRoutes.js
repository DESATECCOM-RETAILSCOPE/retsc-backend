// Rutas para RETSC_OP_RETAILER (catálogo de PDVs).
// Prefijo en app.js: /api/retailers (montado con authMiddleware) — cualquier usuario
// autenticado puede listar tiendas, mismo criterio que /api/categories (catálogo global,
// sin scoping por enterprise ni por rol: lo necesitan tanto EJECUTIVO CAMPO/AUDITOR CAMPO
// para abrir una visita como cualquier admin para soporte/pruebas).

const express = require('express');
const router  = express.Router();
const c       = require('../controllers/retailerController');

// GET /api/retailers
router.get('/', c.listAll);

module.exports = router;
