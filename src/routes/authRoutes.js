const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');

// Rutas públicas

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Inicia sesión y devuelve los tokens de acceso
 *     tags: [Auth]
 *     description: Ruta pública — sin auth. El login corre el chequeo de password ANTES de
 *       verificar si el usuario existe (defensa contra timing attack); "usuario no encontrado"
 *       y "contraseña incorrecta" devuelven el mismo 401 genérico.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email, example: admin@empresa.com }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: Login exitoso — accessToken expira a los 30 min, refreshToken a los 30 días.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string, description: "Alias legacy de accessToken — se mantiene hasta que el frontend migre." }
 *                 accessToken: { type: string }
 *                 refreshToken: { type: string }
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: integer }
 *                     username: { type: string }
 *                     email: { type: string }
 *                     cedIdentidad: { type: string }
 *                     enterpriseId: { type: integer }
 *                     enterpriseDsc: { type: string, nullable: true }
 *                     roleId: { type: integer }
 *                     roleName: { type: string, example: ADMIN }
 *       400:
 *         description: Falta email o password en el body
 *       401:
 *         description: Credenciales inválidas (mensaje genérico — no distingue usuario inexistente de password incorrecta)
 */
router.post('/login',            authController.login);
router.post('/refresh',          authController.refresh);
router.post('/logout',           authController.logout);
router.post('/register',         authController.register);
router.post('/forgot-password',  authController.forgotPassword);

// Rutas protegidas
router.get('/me',    authMiddleware, authController.getMe);
router.get('/users', authMiddleware, authController.getUsers);

module.exports = router;