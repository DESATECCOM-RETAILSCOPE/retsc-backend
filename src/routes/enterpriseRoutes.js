const express = require('express');
const router = express.Router();
const c            = require('../controllers/enterpriseController');
const authMiddleware = require('../middlewares/authMiddleware');
const requireAdmin   = require('../middlewares/requireAdmin');
const requireRole    = require('../middlewares/requireRole');
const { ROLES }       = require('../config/roles');

// Público — registro inicial de empresa + admin
router.post('/', c.registerEnterprise);

// Protegidas — ADMIN o ADMIN_DTC pasan el gate de la ruta; el alcance real
// (ADMIN ve/edita solo la suya, ADMIN_DTC ve/edita todas) se resuelve en el
// controller, que sí conoce el enterpriseId del token.
router.get('/',        authMiddleware, requireAdmin, c.listEnterprises);
router.get('/list',    authMiddleware, requireAdmin, c.listEnterprises);
// CONFIRMAR con la dueña: se asume que crear empresas cliente es función
// exclusiva de DTC — suposición razonable pero no confirmada explícitamente.
router.post('/create', authMiddleware, requireRole(ROLES.ADMIN_DTC), c.createEnterprise);
router.get('/:id',     authMiddleware, requireAdmin, c.getEnterprise);
router.put('/:id',     authMiddleware, requireAdmin, c.updateEnterprise);

module.exports = router;
