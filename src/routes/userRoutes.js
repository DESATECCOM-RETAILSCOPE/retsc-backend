const express = require('express');
const router = express.Router();
const requireAdmin = require('../middlewares/requireAdmin');
const requireRole  = require('../middlewares/requireRole');
const { ROLES }    = require('../config/roles');
const c = require('../controllers/userController');

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         userId:            { type: integer, example: 101 }
 *         userName:          { type: string, example: "Juan Pérez" }
 *         email:             { type: string, example: juan.perez@empresa.com }
 *         cedIdentidad:      { type: string, example: "1-2345-6789", description: "Cédula física, formato Costa Rica" }
 *         roleId:            { type: integer, example: 3 }
 *         roleName:          { type: string, example: EJECUTIVO CAMPO }
 *         status:            { type: integer, enum: [0, 1], description: "Status de la relación usuario-empresa (no del usuario en sí)" }
 *         fechaActivacion:   { type: string, format: date-time, nullable: true }
 *         fechaInactivacion: { type: string, format: date-time, nullable: true }
 *     UserGlobal:
 *       allOf:
 *         - $ref: '#/components/schemas/User'
 *         - type: object
 *           properties:
 *             enterpriseId:  { type: integer }
 *             enterpriseDsc: { type: string, description: "Nombre de la empresa a la que pertenece esta relación" }
 */

// GET /by-cedula/:ced y POST /assign (flujo viejo de "buscar y asignar usuario
// existente") fueron eliminados — feedback de la dueña: una cédula duplicada
// con relación activa en otra empresa ya no debe exponer datos del usuario ni
// ofrecer asignación directa. Ver createUser/createAndAssign en userService.js.

// NOTA (auditoría 2026-07-25): hasta este commit este router no tenía NINGÚN
// chequeo de rol, solo authMiddleware aplicado al montar en app.js — cualquier
// usuario autenticado (EJECUTIVO CAMPO, GERENCIA, AUDITOR CAMPO) podía crear un
// usuario con cualquier Role_id (incluido ADMIN/ADMIN_DTC) y, vía
// PUT /:userId/enterprises/:enterpriseId, ascender su propia relación a ADMIN
// dentro de su empresa. requireAdmin ya equivale a
// requireRole(ROLES.ADMIN, ROLES.ADMIN_DTC) — no crea rol nuevo.
// CONFIRMAR con la dueña al cerrar el mapeo menú↔roles: si algún rol operativo
// (p. ej. GERENCIA) debe poder VER el listado sin poder editarlo, sacar el GET
// de este router.use() y darle su propio requireRole — el resto de las rutas
// (creación/edición/cambio de rol) tiene que seguir restringido a Admin.
router.use(requireAdmin);

// GET /api/users/global — cross-empresa, exclusivo ADMIN_DTC (Issue B3 mismo criterio que
// GET /api/enterprises: un ADMIN de empresa no debe ver usuarios de otras empresas).
// requireRole(ADMIN_DTC) se suma AL requireAdmin de arriba, no lo reemplaza — un ADMIN
// pasa el requireAdmin del router.use() pero no este requireRole más estricto.
// Declarada ANTES de GET '/' (aunque no colisionan: distinta cantidad de segmentos,
// "/global" vs "/") para que quede a prueba de que alguien agregue GET '/:id' después.
/**
 * @swagger
 * /api/users/global:
 *   get:
 *     summary: Listado de usuarios cross-empresa (menú F4, "Usuarios globales")
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Exclusivo ADMIN_DTC — requireRole(ADMIN_DTC) se suma al requireAdmin del
 *       router.use() de arriba, no lo reemplaza. Un ADMIN de empresa pasa el
 *       requireAdmin pero no este chequeo más estricto y recibe 403. A diferencia
 *       de GET /api/users, cada fila incluye enterpriseId/enterpriseDsc para saber
 *       a qué empresa pertenece cada relación.
 *     responses:
 *       200:
 *         description: Lista de usuarios de todas las empresas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 users:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/UserGlobal' }
 *       401:
 *         description: Sin token, o token expirado (code TOKEN_EXPIRED)
 *       403:
 *         description: Autenticado pero no es Admin/Admin_DTC, o es Admin de empresa pero no ADMIN_DTC
 */
router.get('/global', requireRole(ROLES.ADMIN_DTC), c.listGlobalUsers);

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Lista los usuarios de la empresa autenticada
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       authMiddleware se aplica global al montar el router en app.js; requireAdmin
 *       se aplica inline vía router.use() acá mismo (agregado 2026-07-25 — antes
 *       este router no tenía ningún chequeo de rol). Devuelve solo los usuarios con
 *       relación (activa o no) en req.user.enterpriseId, nunca de otras empresas.
 *     responses:
 *       200:
 *         description: Lista de usuarios de la empresa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 users:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/User' }
 *       401:
 *         description: Sin token, o token expirado (code TOKEN_EXPIRED)
 *       403:
 *         description: Autenticado pero sin rol Admin/Admin_DTC (requireAdmin)
 *   post:
 *     summary: Crea (o reactiva) un usuario y lo asigna a la empresa autenticada
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Si la cédula pertenece a un usuario existente SIN relaciones activas en
 *       ninguna empresa, se reactiva en lugar de crear uno nuevo. Si pertenece a
 *       un usuario con una relación activa en OTRA empresa, devuelve 409 con
 *       code CEDULA_EXISTS sin revelar datos del usuario (decisión de negocio,
 *       evita fuga de datos entre empresas). Envía un correo de bienvenida best
 *       effort — un fallo de SMTP no revierte la creación, solo se refleja en el
 *       mensaje de respuesta. Asignar roleId=ADMIN_DTC devuelve 403 a menos que
 *       quien hace la petición sea a su vez ADMIN_DTC (assertCanAssignRole).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cedIdentidad, userName, email, password, roleId]
 *             properties:
 *               cedIdentidad: { type: string, example: "1-2345-6789", description: "Cédula física, 9 dígitos (formato Costa Rica)" }
 *               userName:     { type: string, example: "Juan Pérez" }
 *               email:        { type: string, example: juan.perez@empresa.com }
 *               telephone:    { type: string, nullable: true }
 *               password:     { type: string, format: password, description: "Mínimo 8 caracteres" }
 *               roleId:       { type: integer, description: "Ver GET /api/roles para el catálogo" }
 *     responses:
 *       201:
 *         description: Usuario creado (o reactivado) y asignado a la empresa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 userId:  { type: integer }
 *                 message: { type: string, example: "Usuario creado y asignado a la empresa." }
 *       400:
 *         description: Campos requeridos faltantes, password corto, email/cédula inválidos, o roleId inexistente
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Sin rol Admin, o intentando asignar ADMIN_DTC sin serlo (assertCanAssignRole)
 *       409:
 *         description: >-
 *           Cédula ya registrada con relación activa en otra empresa (code
 *           CEDULA_EXISTS), o email ya en uso
 */
router.get('/',                                  c.listUsers);
router.post('/',                                 c.createUser);

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Actualiza datos de un usuario (nombre, email, contraseña)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Solo puede modificarse un usuario con relación activa en la empresa del
 *       actor (userEnterpriseRepo.findActiveByUserId). No modifica la relación
 *       usuario-empresa (rol/status) — para eso ver PUT /{userId}/enterprises/{enterpriseId}.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: User_id a actualizar
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userName: { type: string }
 *               email:    { type: string }
 *               password: { type: string, format: password, description: "Mínimo 8 caracteres. Omitir para no cambiarla." }
 *     responses:
 *       200:
 *         description: Usuario actualizado (sin PasswordHash)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 user:    { type: object, description: "Registro de RETSC_OP_USERS, sin PasswordHash" }
 *       400:
 *         description: Email inválido o password corto
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: >-
 *           Sin rol Admin, o el usuario no tiene relación activa en la empresa
 *           del actor
 *       404:
 *         description: Usuario no encontrado
 *       409:
 *         description: El email ya está en uso por otro usuario
 */
router.put('/:id',                               c.updateUser);

/**
 * @swagger
 * /api/users/{userId}/enterprises/{enterpriseId}:
 *   put:
 *     summary: Actualiza la relación usuario-empresa (rol, status, fecha de inactivación)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       enterpriseId en la URL debe coincidir con la empresa del actor autenticado
 *       (403 ERR si difiere) — un Admin solo puede modificar relaciones dentro de
 *       su propia empresa. Asignar roleId=ADMIN_DTC devuelve 403 a menos que quien
 *       hace la petición sea a su vez ADMIN_DTC (misma regla que POST /api/users).
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: enterpriseId
 *         required: true
 *         schema: { type: integer }
 *         description: Debe ser igual a req.user.enterpriseId del actor
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               roleId:            { type: integer }
 *               status:            { type: integer, enum: [0, 1] }
 *               fechaInactivacion: { type: string, format: date-time, nullable: true }
 *     responses:
 *       200:
 *         description: Relación usuario-empresa actualizada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:  { type: boolean, example: true }
 *                 relation: { type: object, description: "Registro actualizado de RETSC_OP_USER_ENTERPRISE" }
 *       400:
 *         description: roleId inexistente
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: >-
 *           Sin rol Admin, enterpriseId de la URL distinto al de la empresa del
 *           actor, o intentando asignar ADMIN_DTC sin serlo
 *       404:
 *         description: Relación usuario-empresa no encontrada
 */
router.put('/:userId/enterprises/:enterpriseId', c.updateUserEnterprise);

module.exports = router;
