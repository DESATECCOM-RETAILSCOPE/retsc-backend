const express = require('express');
const router = express.Router();
const c = require('../controllers/userController');

// GET /by-cedula/:ced y POST /assign (flujo viejo de "buscar y asignar usuario
// existente") fueron eliminados — feedback de la dueña: una cédula duplicada
// con relación activa en otra empresa ya no debe exponer datos del usuario ni
// ofrecer asignación directa. Ver createUser/createAndAssign en userService.js.
router.get('/',                                  c.listUsers);
router.post('/',                                 c.createUser);
router.put('/:id',                               c.updateUser);
router.put('/:userId/enterprises/:enterpriseId', c.updateUserEnterprise);

module.exports = router;
