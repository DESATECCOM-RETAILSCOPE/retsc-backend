const express = require('express');
const router = express.Router();
const enterpriseController = require('../controllers/enterpriseController');

// Público — no requiere JWT
router.post('/', enterpriseController.registerEnterprise);

module.exports = router;
