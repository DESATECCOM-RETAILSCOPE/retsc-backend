const express = require('express');
const router = express.Router();
const c = require('../controllers/roleController');
const requireAdmin = require('../middlewares/requireAdmin');
const requireRole  = require('../middlewares/requireRole');
const { ROLES }    = require('../config/roles');

// El catálogo de roles es un artefacto GLOBAL de DTC, no algo por empresa —
// mismo criterio que la taxonomía de categorías (Issue B4, categoryRoutes.js):
// escritura exclusiva de ADMIN_DTC, lectura abierta a cualquier Admin.
// NOTA (auditoría 2026-07-25): hasta este commit ninguna ruta de este router
// tenía chequeo de rol (solo authMiddleware al montar en app.js) — cualquier
// usuario autenticado podía crear/editar roles, incluyendo el propio ADMIN_DTC.
// IMPORTANTE: NO restringir el GET a ADMIN_DTC — useRoles.js del frontend llama
// a GET /api/roles?active=1 para poblar el selector de rol en UserFormModal y
// UserEditModal, y un ADMIN de empresa tiene que poder dar de alta gente.
const dtcOnly = requireRole(ROLES.ADMIN_DTC);

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
 *     description: authMiddleware se aplica GLOBAL en app.js al montar el router;
 *       requireAdmin se aplica inline acá mismo (agregado 2026-07-25 — antes esta
 *       ruta solo tenía authMiddleware, sin chequeo de rol).
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
 *       403:
 *         description: Autenticado pero sin rol Admin/Admin_DTC (requireAdmin, agregado 2026-07-25)
 */
router.get('/',            requireAdmin, c.listRoles);
router.get('/:id',         requireAdmin, c.getRole);
router.post('/',           dtcOnly,      c.createRole);
router.put('/:id',         dtcOnly,      c.updateRole);
router.patch('/:id/status', dtcOnly,     c.setStatus);

module.exports = router;
