const express = require('express');
const router  = express.Router();
const { listCommercialCategories, listSmartByEnterprise } = require('../controllers/categoryController');

// GET /api/enterprises/me/enterprise-categories
router.get('/', listCommercialCategories);

// GET /api/enterprises/me/enterprise-categories/smart
// Categorías inteligentes del enterprise para los formularios de Carga SKU y Góndola.
router.get('/smart', listSmartByEnterprise);

module.exports = router;
