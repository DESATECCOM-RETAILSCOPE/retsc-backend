const express = require('express');
const router = express.Router();
const { listGlobal } = require('../controllers/categoryController');

router.get('/', listGlobal);

module.exports = router;
