const express = require('express');
const router  = express.Router();
const { listCommercialCategories, listSmartByEnterprise } = require('../controllers/categoryController');

/**
 * @swagger
 * components:
 *   schemas:
 *     EnterpriseCommercialCategory:
 *       type: object
 *       properties:
 *         id: { type: integer, example: 7, description: "Igual a enterpriseCategoryId (duplicado en la respuesta por compatibilidad)." }
 *         enterpriseCategoryId: { type: integer, example: 7 }
 *         name: { type: string, example: "Lácteos" }
 *         enterprise_category_dsc: { type: string, example: "Lácteos", description: "Igual a name (duplicado en la respuesta por compatibilidad)." }
 *     EnterpriseSmartCategory:
 *       type: object
 *       properties:
 *         enterpriseCategoryId: { type: integer, example: 7 }
 *         categoryId: { type: integer, example: 34 }
 *         categoryDsc: { type: string, example: "Yogurt" }
 *         parentCategoryId:
 *           type: integer
 *           nullable: true
 *           example: 12
 *         parentDsc:
 *           type: string
 *           nullable: true
 *           example: "Lácteos"
 *         levelNo: { type: integer, example: 2 }
 */

/**
 * @swagger
 * /api/enterprises/me/enterprise-categories:
 *   get:
 *     summary: Categorías comerciales de la empresa del usuario autenticado
 *     tags: [EnterpriseCommercialCategories]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       authMiddleware se aplica GLOBAL en app.js al montar este router bajo
 *       /api/enterprises/me/enterprise-categories. Devuelve las categorías con
 *       su enterprise_category_id, usadas por el formulario de Carga SKU para
 *       asociar un producto a una categoría de la empresa (req.user.enterpriseId,
 *       tomado del token — no hay parámetro de empresa en la URL).
 *     responses:
 *       200:
 *         description: Lista de categorías comerciales de la empresa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 categories:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/EnterpriseCommercialCategory' }
 *       401:
 *         description: Sin token, o token expirado
 */
// GET /api/enterprises/me/enterprise-categories
router.get('/', listCommercialCategories);

/**
 * @swagger
 * /api/enterprises/me/enterprise-categories/smart:
 *   get:
 *     summary: Categorías inteligentes (smart DTC) de la empresa, con info del padre
 *     tags: [EnterpriseCommercialCategories]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       authMiddleware se aplica GLOBAL en app.js al montar este router. Solo
 *       devuelve categorías marcadas is_smart_dtc de las que la empresa
 *       seleccionó, ya deduplicadas (si la empresa eligió un padre con varias
 *       hijas smart, cada hija aparece una sola vez). Alimenta los selectores
 *       de categoría en los formularios de Carga SKU y Fotos de Góndola — NO
 *       usar GET /api/categories filtrado por is_smart_dtc en el cliente para
 *       este caso, ese endpoint devuelve TODAS las categorías DTC globales,
 *       no las de la empresa, y no viene deduplicado por selección de la
 *       empresa.
 *     responses:
 *       200:
 *         description: Lista de categorías inteligentes de la empresa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 categories:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/EnterpriseSmartCategory' }
 *       401:
 *         description: Sin token, o token expirado
 */
// GET /api/enterprises/me/enterprise-categories/smart
// Categorías inteligentes del enterprise para los formularios de Carga SKU y Góndola.
router.get('/smart', listSmartByEnterprise);

module.exports = router;
