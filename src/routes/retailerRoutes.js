// Rutas para RETSC_OP_RETAILER (catálogo de PDVs).
// Prefijo en app.js: /api/retailers (montado con authMiddleware) — cualquier usuario
// autenticado puede listar tiendas, mismo criterio que /api/categories (catálogo global,
// sin scoping por enterprise ni por rol: lo necesitan tanto EJECUTIVO CAMPO/AUDITOR CAMPO
// para abrir una visita como cualquier admin para soporte/pruebas).

const express = require('express');
const router  = express.Router();
const c       = require('../controllers/retailerController');

/**
 * @swagger
 * components:
 *   schemas:
 *     Retailer:
 *       type: object
 *       properties:
 *         Retailer_id:          { type: integer, example: 42 }
 *         Retailer_dsc:         { type: string, example: "Auto Mercado Escazú" }
 *         Supermarketchain_id:  { type: integer, nullable: true }
 *         Formato:              { type: string, nullable: true, example: "Supermercado" }
 *         latitud:              { type: number, format: float, nullable: true, example: 9.9281 }
 *         longitud:             { type: number, format: float, nullable: true, example: -84.0907 }
 *         Ejecutivo_asignado:   { type: string, nullable: true }
 *         Zona:                 { type: string, nullable: true }
 *         Prioridad:            { type: string, nullable: true }
 *         Canal:                { type: string, nullable: true, enum: [OMT, DTT, CONVENIENCE] }
 *         pais_dsc:             { type: string, nullable: true }
 */

/**
 * @swagger
 * /api/retailers:
 *   get:
 *     summary: Catálogo completo de puntos de venta (PDV)
 *     tags: [Retailers]
 *     security:
 *       - bearerAuth: []
 *     description: Catálogo global sin scoping por enterprise ni por rol — RETSC_OP_RETAILER
 *       no tiene columna enterprise_id, igual que RETSC_OP_CATEGORIES. Sin paginar. Lo usa el
 *       mobile para poblar el mapa de selección de tienda (Paso 0, guía "Fotos de Visita"
 *       v1.9) antes de POST /api/visits.
 *     responses:
 *       200:
 *         description: Lista de PDVs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 retailers:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Retailer' }
 *       401:
 *         description: Sin token, o token expirado
 */
router.get('/', c.listAll);

module.exports = router;
