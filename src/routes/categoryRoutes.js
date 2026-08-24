const express      = require("express");
const router       = express.Router();
const requireRole    = require("../middlewares/requireRole");
const { ROLES }       = require("../config/roles");
const {
  listGlobal,
  getRoots,
  getChildren,
  getById,
  createCategory,
  updateCategory,
  deactivateCategory,
  retryAiInfra,
} = require("../controllers/categoryController");

// authMiddleware ya se aplica globalmente sobre todo /api/categories en app.js.

/**
 * @swagger
 * components:
 *   schemas:
 *     Category:
 *       type: object
 *       properties:
 *         categoryId: { type: integer, example: 38 }
 *         categoryDsc: { type: string, example: "DESODORANTES CORPORALES" }
 *         levelNo: { type: integer, description: "0 para categorías raíz, se incrementa 1 por cada nivel de profundidad." }
 *         parentCategoryId: { type: integer, nullable: true }
 *         isSmartDtc: { type: boolean, description: "Si es true, esta categoría tiene (o debería tener) infraestructura IA provisionada (Blob + Custom Vision)." }
 *         status: { type: string, enum: [ACTIVE, INACTIVE] }
 */

/**
 * @swagger
 * /api/categories:
 *   get:
 *     summary: Lista el árbol global de categorías activas (RETSC_OP_CATEGORIES)
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Lectura abierta a cualquier usuario autenticado (Issue B4) — solo la
 *       gestión/escritura del árbol es exclusiva de ADMIN_DTC. Alimenta los
 *       dropdowns de Carga de SKUs, Fotos de Góndola, Productos, etc.
 *     responses:
 *       200:
 *         description: Lista plana de categorías activas (no anidada, usar parentCategoryId para reconstruir el árbol)
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
 *   post:
 *     summary: Crea una nueva categoría en el árbol
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Exclusivo ADMIN_DTC (requireRole, Issue B4 — antes cualquier usuario
 *       autenticado podía disparar esto). Si `isSmartDtc` es true, dispara en
 *       background (fire-and-forget, no bloquea la respuesta) el provisioning
 *       de infraestructura IA (Blob + Custom Vision) vía aiInfrastructureService.
 *       Si ese provisioning falla, la categoría queda con estado interno
 *       PENDING/PENDING_AZURE y puede reintentarse con
 *       POST /api/categories/{id}/retry-ai-infra.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [categoryDsc]
 *             properties:
 *               categoryDsc: { type: string, maxLength: 50, description: "Se normaliza a mayúsculas y se recorta (trim) antes de guardar." }
 *               parentCategoryId: { type: integer, nullable: true, default: null, description: "Si se omite o es null, la categoría se crea como raíz (levelNo=0)." }
 *               isSmartDtc: { type: boolean, default: false }
 *     responses:
 *       201:
 *         description: Categoría creada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 category: { $ref: '#/components/schemas/Category' }
 *       400:
 *         description: categoryDsc faltante/vacío/mayor a 50 caracteres, o parentCategoryId apunta a una categoría inactiva
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero no es ADMIN_DTC
 *       404:
 *         description: parentCategoryId no existe
 */
router.get("/",              listGlobal);   // GET  /api/categories

/**
 * @swagger
 * /api/categories/roots:
 *   get:
 *     summary: Lista solo las categorías raíz (sin padre) del árbol
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de categorías raíz
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
 *         description: Sin token, o token expirado
 */
router.get("/roots",         getRoots);     // GET  /api/categories/roots

/**
 * @swagger
 * /api/categories/{id}/children:
 *   get:
 *     summary: Lista las categorías hijas directas de una categoría
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: categoryId de la categoría padre.
 *     responses:
 *       200:
 *         description: Lista de categorías hijas directas (no recursivo)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 categories:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Category' }
 *       400:
 *         description: id no es numérico, o la categoría padre está inactiva
 *       401:
 *         description: Sin token, o token expirado
 *       404:
 *         description: La categoría padre no existe
 */
router.get("/:id/children",  getChildren);  // GET  /api/categories/:id/children

/**
 * @swagger
 * /api/categories/{id}:
 *   get:
 *     summary: Obtiene una categoría por id
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Categoría encontrada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 category: { $ref: '#/components/schemas/Category' }
 *       400:
 *         description: id no es numérico
 *       401:
 *         description: Sin token, o token expirado
 *       404:
 *         description: La categoría no existe
 *   put:
 *     summary: Actualiza (parcialmente) una categoría existente
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Exclusivo ADMIN_DTC (requireRole). Todos los campos del body son
 *       opcionales — solo se actualizan los que vienen presentes. Si
 *       `isSmartDtc` pasa de false a true en esta misma operación, dispara
 *       (fire-and-forget) el provisioning de infraestructura IA, igual que en
 *       el POST. Mover una categoría a uno de sus propios descendientes está
 *       bloqueado (evita ciclos en el árbol).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               categoryDsc: { type: string, maxLength: 50 }
 *               isSmartDtc: { type: boolean }
 *               parentCategoryId: { type: integer, nullable: true, description: "null mueve la categoría a raíz (levelNo=0)." }
 *               status: { type: string, enum: [ACTIVE, INACTIVE] }
 *     responses:
 *       200:
 *         description: Categoría actualizada (o sin cambios, si el body no traía campos)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 category: { $ref: '#/components/schemas/Category' }
 *       400:
 *         description: >-
 *           id no numérico, categoryDsc vacío/mayor a 50 caracteres, status
 *           inválido, parentCategoryId igual al propio id, parentCategoryId
 *           inactivo, o parentCategoryId es un descendiente de esta categoría
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero no es ADMIN_DTC
 *       404:
 *         description: La categoría no existe, o parentCategoryId no existe
 *   delete:
 *     summary: Desactiva (soft-delete) una categoría y todos sus descendientes
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Exclusivo ADMIN_DTC (requireRole). No borra filas — pone status=INACTIVE
 *       en la categoría y en cascada en todos sus descendientes activos.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Categoría (y descendientes) desactivados
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Categoría desactivada. 3 descendiente(s) también desactivado(s)." }
 *                 deactivated: { type: integer, description: "Total de filas afectadas (1 + descendientes)." }
 *       400:
 *         description: id no numérico, o la categoría ya estaba inactiva
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero no es ADMIN_DTC
 *       404:
 *         description: La categoría no existe
 */
router.get("/:id",           getById);      // GET  /api/categories/:id

// ────────────── Escritura (Taxonomía DTC — exclusivo ADMIN_DTC) ────────────────
// Abrir/editar una categoría acá crea los contenedores vacíos en
// GLOBAL_TRAINING_SKU / GLOBAL_SHELF_TRAINING y arma los modelos de
// entrenamiento — antes no tenía NINGÚN rol asignado (cualquier usuario
// autenticado podía disparar esto), solo un comentario "rol se agrega en
// iteración futura" que nunca se completó.
const dtcOnly = requireRole(ROLES.ADMIN_DTC);
router.post("/",    dtcOnly, createCategory);    // POST   /api/categories
router.put("/:id",  dtcOnly, updateCategory);    // PUT    /api/categories/:id
router.delete("/:id", dtcOnly, deactivateCategory); // DELETE /api/categories/:id

/**
 * @swagger
 * /api/categories/{id}/retry-ai-infra:
 *   post:
 *     summary: Reintenta el provisioning de infraestructura IA de una categoría smart DTC
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Exclusivo ADMIN_DTC (requireRole). Reintenta el provisioning de Blob +
 *       Custom Vision para una categoría con `isSmartDtc=true` que quedó en
 *       estado interno PENDING o PENDING_AZURE por un fallo temporal de Azure.
 *       Si la categoría no es smart DTC, o no existe, responde con status ERROR
 *       (HTTP 400) en vez de 404, para distinguirlo de un error de validación
 *       de infraestructura.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Provisioning completado o ya existente (status PROVISIONED o ALREADY_EXISTS)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 status: { type: string, enum: [PROVISIONED, PENDING, ALREADY_EXISTS, ERROR] }
 *                 errors:
 *                   type: array
 *                   items: { type: string }
 *                   description: Presente cuando algún componente individual falló o quedó pendiente.
 *       400:
 *         description: >-
 *           status=ERROR — la categoría no existe, no es smart DTC, o falló
 *           algún paso del provisioning (ver campo errors)
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero no es ADMIN_DTC
 */
router.post("/:id/retry-ai-infra", dtcOnly, retryAiInfra);

module.exports = router;
