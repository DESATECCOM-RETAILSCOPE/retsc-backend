const express = require('express');
const router = express.Router();
const c            = require('../controllers/enterpriseController');
const authMiddleware = require('../middlewares/authMiddleware');
const requireAdmin   = require('../middlewares/requireAdmin');
const requireRole    = require('../middlewares/requireRole');
const { ROLES }       = require('../config/roles');

/**
 * @swagger
 * components:
 *   schemas:
 *     Enterprise:
 *       type: object
 *       properties:
 *         enterpriseId: { type: integer, example: 12 }
 *         fiscalId: { type: string, example: "3101123456", description: "Cédula jurídica, 10 dígitos, sin guiones (normalizada en el servicio)." }
 *         enterpriseDsc: { type: string, example: "Distribuidora ACME S.A." }
 *         country: { type: string, example: "Costa Rica" }
 *         state: { type: string, example: "San José" }
 *         county: { type: string, example: "Central" }
 *         city: { type: string, example: "San José" }
 *         telephone: { type: string, example: "22223333" }
 *         address: { type: string, example: "Av. Central, calle 5" }
 *         invoiceMail: { type: string, example: "facturacion@acme.cr" }
 *         contact: { type: string, example: "María Pérez" }
 *         contactMail: { type: string, example: "maria@acme.cr" }
 *         contactPhone: { type: string, example: "88889999" }
 *         type:
 *           type: string
 *           enum: [Proveedor, Detallista, "Empresa de servicios"]
 *         status: { type: integer, enum: [0, 1] }
 *         activeUsersCount:
 *           type: integer
 *           description: >-
 *             Solo presente en las respuestas de listado/detalle (GET), no en la
 *             creación — cuenta las relaciones RETSC_OP_USER_ENTERPRISE activas
 *             (Status=1) de la empresa.
 *     EnterpriseRegisterRequest:
 *       type: object
 *       required:
 *         - fiscalId
 *         - enterpriseDsc
 *         - country
 *         - state
 *         - county
 *         - city
 *         - telephone
 *         - address
 *         - invoiceMail
 *         - contact
 *         - contactMail
 *         - contactPhone
 *         - type
 *         - adminCedula
 *         - adminName
 *         - adminEmail
 *       properties:
 *         fiscalId: { type: string, example: "3101123456", description: "Cédula jurídica CR, 10 dígitos." }
 *         enterpriseDsc: { type: string, example: "Distribuidora ACME S.A." }
 *         country: { type: string, example: "Costa Rica" }
 *         state: { type: string, example: "San José" }
 *         county: { type: string, example: "Central" }
 *         city: { type: string, example: "San José" }
 *         telephone: { type: string, example: "22223333" }
 *         address: { type: string, example: "Av. Central, calle 5" }
 *         invoiceMail: { type: string, example: "facturacion@acme.cr" }
 *         contact: { type: string, example: "María Pérez" }
 *         contactMail: { type: string, example: "maria@acme.cr" }
 *         contactPhone: { type: string, example: "88889999" }
 *         type:
 *           type: string
 *           enum: [Proveedor, Detallista, "Empresa de servicios"]
 *         adminCedula: { type: string, example: "112345678", description: "Cédula física CR del administrador, 9 dígitos." }
 *         adminName: { type: string, example: "Juan Rodríguez" }
 *         adminEmail: { type: string, example: "juan@acme.cr" }
 *         adminPhone: { type: string, example: "87776666" }
 *     EnterpriseCreateRequest:
 *       type: object
 *       description: >-
 *         Igual que EnterpriseRegisterRequest pero SIN los campos admin* — esta
 *         ruta solo crea la empresa, no un usuario administrador.
 *       required:
 *         - fiscalId
 *         - enterpriseDsc
 *         - country
 *         - state
 *         - county
 *         - city
 *         - telephone
 *         - address
 *         - invoiceMail
 *         - contact
 *         - contactMail
 *         - contactPhone
 *         - type
 *       properties:
 *         fiscalId: { type: string, example: "3101123456" }
 *         enterpriseDsc: { type: string, example: "Distribuidora ACME S.A." }
 *         country: { type: string, example: "Costa Rica" }
 *         state: { type: string, example: "San José" }
 *         county: { type: string, example: "Central" }
 *         city: { type: string, example: "San José" }
 *         telephone: { type: string, example: "22223333" }
 *         address: { type: string, example: "Av. Central, calle 5" }
 *         invoiceMail: { type: string, example: "facturacion@acme.cr" }
 *         contact: { type: string, example: "María Pérez" }
 *         contactMail: { type: string, example: "maria@acme.cr" }
 *         contactPhone: { type: string, example: "88889999" }
 *         type:
 *           type: string
 *           enum: [Proveedor, Detallista, "Empresa de servicios"]
 *     EnterpriseUpdateRequest:
 *       type: object
 *       description: >-
 *         Todos los campos son opcionales (update parcial). fiscalId NO puede
 *         modificarse (400 si se envía). Incluye status, que no existe en el
 *         alta.
 *       properties:
 *         enterpriseDsc: { type: string }
 *         country: { type: string }
 *         state: { type: string }
 *         county: { type: string }
 *         city: { type: string }
 *         telephone: { type: string }
 *         address: { type: string }
 *         invoiceMail: { type: string }
 *         contact: { type: string }
 *         contactMail: { type: string }
 *         contactPhone: { type: string }
 *         type:
 *           type: string
 *           enum: [Proveedor, Detallista, "Empresa de servicios"]
 *         status:
 *           type: integer
 *           enum: [0, 1]
 */

/**
 * @swagger
 * /api/enterprises:
 *   post:
 *     summary: Registra una empresa nueva junto con su usuario administrador
 *     tags: [Enterprises]
 *     description: >-
 *       Ruta pública, sin autenticación (ni authMiddleware ni requireAdmin se
 *       aplican). Valida cédula jurídica CR (fiscalId, 10 dígitos) y cédula
 *       física CR del administrador (adminCedula, 9 dígitos). Si adminEmail /
 *       adminCedula ya corresponden a un usuario sin relaciones activas, se
 *       reactiva ese usuario con un password nuevo en vez de crear uno
 *       duplicado.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/EnterpriseRegisterRequest' }
 *     responses:
 *       201:
 *         description: Empresa (y usuario administrador) registrados
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 enterpriseId: { type: integer, example: 12 }
 *                 userId: { type: integer, example: 45 }
 *                 isNewUser: { type: boolean }
 *                 generatedPassword:
 *                   type: string
 *                   description: >-
 *                     Solo presente cuando isNewUser es true. No se vuelve a
 *                     mostrar — el frontend debe entregarlo al administrador
 *                     en esta misma respuesta.
 *                 message: { type: string }
 *       400:
 *         description: >-
 *           Campos requeridos faltantes, type inválido, formato de email
 *           inválido, o cédula jurídica/física con formato incorrecto.
 *       409:
 *         description: >-
 *           Conflicto de duplicados. El body incluye field y errorCode además
 *           del message en español, para que el frontend marque el input
 *           exacto sin parsear texto. Posibles errorCode: ERR_DUP_FISCAL_ID
 *           (ya existe una empresa con ese fiscalId, field=fiscalId),
 *           ERR_CEDULA_ACTIVE_ELSEWHERE (el administrador ya tiene una
 *           empresa activa asignada con esa cédula, field=adminCedula),
 *           ERR_DUP_EMAIL (el adminEmail pertenece a otro usuario distinto,
 *           field=adminEmail).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string }
 *                 field: { type: string, example: fiscalId }
 *                 errorCode: { type: string, example: ERR_DUP_FISCAL_ID }
 *   get:
 *     summary: Lista empresas (alias de /api/enterprises/list)
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Requiere rol Admin o Admin_DTC (requireAdmin). ADMIN_DTC ve TODAS las
 *       empresas; un ADMIN normal ve solo la suya (la de su propio token),
 *       nunca la lista completa.
 *     responses:
 *       200:
 *         description: Lista de empresas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 enterprises:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Enterprise' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol Admin/Admin_DTC
 */
router.post('/', c.registerEnterprise);

/**
 * @swagger
 * /api/enterprises/list:
 *   get:
 *     summary: Lista empresas (idéntico comportamiento que GET /api/enterprises)
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Requiere rol Admin o Admin_DTC. ADMIN_DTC ve todas las empresas; un
 *       ADMIN normal ve solo la suya.
 *     responses:
 *       200:
 *         description: Lista de empresas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 enterprises:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Enterprise' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol Admin/Admin_DTC
 */

// Protegidas — ADMIN o ADMIN_DTC pasan el gate de la ruta; el alcance real
// (ADMIN ve/edita solo la suya, ADMIN_DTC ve/edita todas) se resuelve en el
// controller, que sí conoce el enterpriseId del token.
router.get('/',        authMiddleware, requireAdmin, c.listEnterprises);
router.get('/list',    authMiddleware, requireAdmin, c.listEnterprises);
/**
 * @swagger
 * /api/enterprises/create:
 *   post:
 *     summary: Crea una empresa sin usuario administrador (uso exclusivo Admin_DTC)
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Restringida a rol ADMIN_DTC (requireRole). A diferencia de
 *       POST /api/enterprises, no recibe ni crea datos de usuario
 *       administrador — solo el registro de la empresa.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/EnterpriseCreateRequest' }
 *     responses:
 *       201:
 *         description: Empresa creada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 enterprise: { $ref: '#/components/schemas/Enterprise' }
 *       400:
 *         description: Campos requeridos faltantes, type inválido, o formato de email/cédula jurídica incorrecto
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol Admin_DTC
 *       409:
 *         description: >-
 *           Ya existe una empresa registrada con ese fiscalId. Body incluye
 *           field=fiscalId y errorCode=ERR_DUP_FISCAL_ID.
 */
// CONFIRMAR con la dueña: se asume que crear empresas cliente es función
// exclusiva de DTC — suposición razonable pero no confirmada explícitamente.
router.post('/create', authMiddleware, requireRole(ROLES.ADMIN_DTC), c.createEnterprise);
/**
 * @swagger
 * /api/enterprises/{id}:
 *   get:
 *     summary: Detalle de una empresa por id
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       ADMIN_DTC puede consultar cualquier empresa. Un ADMIN normal solo
 *       puede consultar la suya propia (la de su token) — 403 si :id no
 *       coincide con su enterpriseId.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Enterprise_id de la empresa a consultar.
 *     responses:
 *       200:
 *         description: Empresa encontrada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 enterprise: { $ref: '#/components/schemas/Enterprise' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: >-
 *           Autenticado pero sin rol Admin/Admin_DTC, o es ADMIN y :id no es
 *           su propia empresa ("No tiene permiso para ver esta empresa.").
 *       404:
 *         description: Empresa no encontrada
 *   put:
 *     summary: Actualiza una empresa existente
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Misma regla de acceso que el GET por id: ADMIN_DTC puede modificar
 *       cualquier empresa, un ADMIN normal solo la suya (403 si no). El
 *       fiscalId no puede modificarse (400 si se envía en el body).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Enterprise_id de la empresa a modificar.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/EnterpriseUpdateRequest' }
 *     responses:
 *       200:
 *         description: Empresa actualizada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 enterprise: { $ref: '#/components/schemas/Enterprise' }
 *       400:
 *         description: Se intentó modificar fiscalId, o type/formato de email inválido
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: >-
 *           Autenticado pero sin rol Admin/Admin_DTC, o es ADMIN y :id no es
 *           su propia empresa ("No tiene permiso para modificar esta
 *           empresa.").
 *       404:
 *         description: Empresa no encontrada
 */
router.get('/:id',     authMiddleware, requireAdmin, c.getEnterprise);
router.put('/:id',     authMiddleware, requireAdmin, c.updateEnterprise);

module.exports = router;
