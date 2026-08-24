const express = require('express');
const router = express.Router();
const { listByEnterprise, replaceForEnterprise } = require('../controllers/categoryController');

// authMiddleware ya se aplica globalmente sobre todo /api/enterprises/me/categories
// en app.js — ninguna ruta de este router agrega un chequeo de rol adicional,
// cualquier usuario autenticado de la empresa puede leer y modificar su propia
// selección de categorías (enterpriseId sale del JWT, no de un parámetro).

/**
 * @swagger
 * /api/enterprises/me/categories:
 *   get:
 *     summary: Lista las categorías seleccionadas por la empresa autenticada
 *     tags: [EnterpriseCategories]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       `enterpriseId` se toma del JWT (req.user.enterpriseId), no de un
 *       parámetro. Deduplica por selected_category_id — una misma categoría
 *       seleccionada puede tener varias filas resueltas (DIRECT/EXPAND/COLLAPSE)
 *       en RETSC_ENTERPRISE_CATEGORIES, pero acá aparece una sola vez.
 *     responses:
 *       200:
 *         description: Categorías seleccionadas por la empresa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 categories:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Category' }
 *       401:
 *         description: Sin token, o token expirado (code TOKEN_EXPIRED)
 *   put:
 *     summary: Reemplaza atómicamente la selección de categorías de la empresa
 *     tags: [EnterpriseCategories]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Agrega las categorías nuevas (resolviendo cada una vía el algoritmo
 *       DIRECT/EXPAND/COLLAPSE hacia categorías `isSmartDtc`), quita las que ya
 *       no vienen en `categoryIds`, y deja intacta la selección que sigue igual
 *       en ambos lados. Corrige un bug histórico en el que un PUT que quitaba
 *       una categoría del array no la borraba realmente (solo agregaba, nunca
 *       inactivaba). Cada id de `categoryIds` debe existir y estar ACTIVE.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [categoryIds]
 *             properties:
 *               categoryIds:
 *                 type: array
 *                 items: { type: integer }
 *                 description: Selección completa deseada (no un delta) — reemplaza todo lo guardado previamente.
 *     responses:
 *       200:
 *         description: Selección reemplazada (o sin cambios, si ya coincidía)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 added: { type: integer }
 *                 removed: { type: integer }
 *                 alreadyExisted: { type: integer }
 *                 message: { type: string, example: "Categoría(s): 2 agregada(s), 1 quitada(s)." }
 *       400:
 *         description: categoryIds no es un array, o alguno de sus ids no existe / no está ACTIVE
 *       401:
 *         description: Sin token, o token expirado
 */
router.get('/',  listByEnterprise);
router.put('/',  replaceForEnterprise);

module.exports = router;
