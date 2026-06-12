const express = require('express');
const router  = express.Router();
const { listCommercialCategories } = require('../controllers/categoryController');

// GET /api/enterprises/me/enterprise-categories
router.get('/', listCommercialCategories);

module.exports = router;
