const express = require('express');
const router = express.Router();
const c            = require('../controllers/enterpriseController');
const authMiddleware = require('../middlewares/authMiddleware');
const requireAdmin   = require('../middlewares/requireAdmin');

// Público — registro inicial de empresa + admin
router.post('/', c.registerEnterprise);

// Protegidas — solo Admin
router.get('/list',    authMiddleware, requireAdmin, c.listEnterprises);
router.post('/create', authMiddleware, requireAdmin, c.createEnterprise);
router.get('/:id',     authMiddleware, requireAdmin, c.getEnterprise);
router.put('/:id',     authMiddleware, requireAdmin, c.updateEnterprise);

module.exports = router;
