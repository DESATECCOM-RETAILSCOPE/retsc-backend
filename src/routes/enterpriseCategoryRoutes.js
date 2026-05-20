const express = require('express');
const router = express.Router();
const { listByEnterprise, replaceForEnterprise } = require('../controllers/categoryController');

router.get('/',  listByEnterprise);
router.put('/',  replaceForEnterprise);

module.exports = router;
