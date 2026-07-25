const express = require('express');
const router = express.Router();
const requireAdmin = require('../middlewares/requireAdmin');
const c = require('../controllers/userController');

// GET /by-cedula/:ced y POST /assign (flujo viejo de "buscar y asignar usuario
// existente") fueron eliminados — feedback de la dueña: una cédula duplicada
// con relación activa en otra empresa ya no debe exponer datos del usuario ni
// ofrecer asignación directa. Ver createUser/createAndAssign en userService.js.

// NOTA (auditoría 2026-07-25): hasta este commit este router no tenía NINGÚN
// chequeo de rol, solo authMiddleware aplicado al montar en app.js — cualquier
// usuario autenticado (EJECUTIVO CAMPO, GERENCIA, AUDITOR CAMPO) podía crear un
// usuario con cualquier Role_id (incluido ADMIN/ADMIN_DTC) y, vía
// PUT /:userId/enterprises/:enterpriseId, ascender su propia relación a ADMIN
// dentro de su empresa. requireAdmin ya equivale a
// requireRole(ROLES.ADMIN, ROLES.ADMIN_DTC) — no crea rol nuevo.
// CONFIRMAR con la dueña al cerrar el mapeo menú↔roles: si algún rol operativo
// (p. ej. GERENCIA) debe poder VER el listado sin poder editarlo, sacar el GET
// de este router.use() y darle su propio requireRole — el resto de las rutas
// (creación/edición/cambio de rol) tiene que seguir restringido a Admin.
router.use(requireAdmin);

router.get('/',                                  c.listUsers);
router.post('/',                                 c.createUser);
router.put('/:id',                               c.updateUser);
router.put('/:userId/enterprises/:enterpriseId', c.updateUserEnterprise);

module.exports = router;
