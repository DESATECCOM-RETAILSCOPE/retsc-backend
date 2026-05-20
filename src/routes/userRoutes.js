const express = require('express');
const router = express.Router();
const c = require('../controllers/userController');

router.get('/',                                  c.listUsers);
router.get('/by-cedula/:ced',                    c.findByCedula);
router.post('/',                                 c.createUser);
router.post('/assign',                           c.assignUser);
router.put('/:id',                               c.updateUser);
router.put('/:userId/enterprises/:enterpriseId', c.updateUserEnterprise);

module.exports = router;
