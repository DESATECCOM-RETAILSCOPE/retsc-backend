const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');

// Rutas públicas
router.post('/login',    authController.login);
router.post('/register', authController.register);

// Rutas protegidas
router.get('/me',    authMiddleware, authController.getMe);
router.get('/users', authMiddleware, authController.getUsers);

module.exports = router;
