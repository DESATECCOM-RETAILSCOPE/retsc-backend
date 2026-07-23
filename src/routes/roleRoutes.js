const express = require('express');
const router = express.Router();
const c = require('../controllers/roleController');

/**
 * @swagger
 * components:
 *   schemas:
 *     Role:
 *       type: object
 *       properties:
 *         roleId: { type: integer, example: 1 }
 *         roleName: { type: string, example: ADMIN, description: "Siempre en mayúsculas — ver src/config/roles.js" }
 *         description: { type: string }
 *         status: { type: integer, enum: [0, 1] }
 */

/**
 * @swagger
 * /api/roles:
 *   get:
 *     summary: Lista los roles de RETSC_OP_ROLES
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     description: Montada con auth GLOBAL en app.js (authMiddleware aplicado al montar
 *       el router, no dentro de roleRoutes.js) — patrón 1 de los 3 de montaje de este repo.
 *     parameters:
 *       - in: query
 *         name: active
 *         schema: { type: string, enum: ['1'] }
 *         description: Si es exactamente "1", filtra solo roles con status=1. Cualquier otro valor (u omitirlo) devuelve todos.
 *     responses:
 *       200:
 *         description: Lista de roles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 roles:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Role' }
 *       401:
 *         description: Sin token, o token expirado (code TOKEN_EXPIRED)
 */
router.get('/',            c.listRoles);
router.get('/:id',         c.getRole);
router.post('/',           c.createRole);
router.put('/:id',         c.updateRole);
router.patch('/:id/status', c.setStatus);

module.exports = router;
