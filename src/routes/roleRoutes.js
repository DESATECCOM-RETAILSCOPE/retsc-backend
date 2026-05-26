const express = require('express');
const router = express.Router();
const c = require('../controllers/roleController');

router.get('/',            c.listRoles);
router.get('/:id',         c.getRole);
router.post('/',           c.createRole);
router.put('/:id',         c.updateRole);
router.patch('/:id/status', c.setStatus);

module.exports = router;
