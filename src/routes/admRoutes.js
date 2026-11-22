/**
 * admRoutes.js — Rutas del módulo administrativo (/api/adm): contrato y datos de facturación.
 *
 * Para qué sirve: declara qué rutas existen y qué roles pueden usarlas. El control de
 *   acceso real vive aquí y en el servicio (admScope); ocultar botones en la pantalla
 *   no cuenta como seguridad.
 * Dependencias externas pendientes:
 *   // TODO: confirmar con María qué roles de la empresa cliente pueden ver el contrato y
 *   //       los datos de facturación. Hoy: ADMIN y GERENCIA (información financiera).
 *   //       Se puede cambiar sin tocar código con la variable ADM_CLIENT_VIEW_ROLES.
 * TODO conocidos:
 *   // TODO: agregar aquí las rutas de OC, facturas, pagos, documentos, antigüedad y
 *   //       bitácora en los pasos 3 a 8 del módulo.
 *
 * NOTA: este router se monta en app.js con authMiddleware:
 *         app.use('/api/adm', authMiddleware, admRoutes);
 *       y es independiente de /api/dashboard/*.
 */

const express = require('express');
const router = express.Router();
const requireRole = require('../middlewares/requireRole');
const { ROLES } = require('../config/roles');
const contractController = require('../controllers/admContractController');
const billingController = require('../controllers/admBillingProfileController');

// Roles de la empresa cliente que pueden VER contrato y datos de facturación.
// Mismo estilo que otros routers (shelf-photos, annotations): lista separada por comas
// en una variable de entorno, con un valor por defecto.
const CLIENT_VIEW_ROLES = (process.env.ADM_CLIENT_VIEW_ROLES || 'ADMIN,GERENCIA')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

// ADMIN_DTC (usuario interno) siempre puede ver; se le suman los roles de cliente permitidos.
const canView = requireRole(ROLES.ADMIN_DTC, ...CLIENT_VIEW_ROLES);
// Solo usuarios internos de DTC pueden crear o editar.
const dtcOnly = requireRole(ROLES.ADMIN_DTC);

/**
 * @swagger
 * /api/adm/contract:
 *   get:
 *     summary: Contrato ACTIVO de la empresa
 *     description: Cliente = su empresa (del token). ADMIN_DTC debe indicar ?enterpriseId=.
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: enterpriseId
 *         schema: { type: integer }
 *         description: Solo para ADMIN_DTC (obligatorio). Para un cliente, otra empresa responde 404.
 *     responses:
 *       200: { description: "{ success, contract } — contract es null si la empresa no tiene contrato activo" }
 *       401: { description: Sin token o token inválido }
 *       403: { description: Rol sin permiso }
 *       404: { description: Un cliente pidió otra empresa }
 *       422: { description: ADMIN_DTC sin ?enterpriseId= }
 */
router.get('/contract', canView, contractController.getActiveContract);

/**
 * @swagger
 * /api/adm/contracts:
 *   get:
 *     summary: Todos los contratos de una empresa (solo DTC)
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: enterpriseId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ success, contracts: [] }" }
 *       403: { description: Rol sin permiso }
 *       422: { description: Falta enterpriseId }
 *   post:
 *     summary: Crear un contrato (solo DTC)
 *     description: Solo puede haber un contrato ACTIVO por empresa; un segundo se rechaza con 422.
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enterpriseId, planCode, startDate, billingFrequency, amountPerPeriod, currency, paymentMethod, creditDays, requiresPo]
 *             properties:
 *               enterpriseId: { type: integer }
 *               planCode: { type: string, maxLength: 30 }
 *               status: { type: string, enum: [BORRADOR, ACTIVO], default: BORRADOR }
 *               startDate: { type: string, format: date }
 *               endDate: { type: string, format: date }
 *               billingFrequency: { type: string, enum: [MENSUAL, TRIMESTRAL, ANUAL] }
 *               amountPerPeriod: { type: number }
 *               currency: { type: string, enum: [CRC, USD] }
 *               paymentMethod: { type: string, enum: [PASARELA, OC_FACTURA] }
 *               creditDays: { type: integer, minimum: 0, maximum: 180 }
 *               requiresPo: { type: boolean }
 *               issuerName: { type: string, maxLength: 150 }
 *     responses:
 *       201: { description: "{ success, contract }" }
 *       403: { description: Rol sin permiso }
 *       422: { description: "Validación o segundo contrato ACTIVO. { success:false, message, field }" }
 */
router.get('/contracts', dtcOnly, contractController.listContracts);
router.post('/contracts', dtcOnly, contractController.createContract);

/**
 * @swagger
 * /api/adm/contracts/{id}:
 *   put:
 *     summary: Editar un contrato (solo DTC; edición parcial)
 *     description: Transiciones de estado BORRADOR→ACTIVO→FINALIZADO; FINALIZADO no se edita.
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ success, contract }" }
 *       403: { description: Rol sin permiso }
 *       404: { description: Contrato no encontrado }
 *       422: { description: Validación, transición no permitida o segundo contrato ACTIVO }
 */
router.put('/contracts/:id', dtcOnly, contractController.updateContract);

/**
 * @swagger
 * /api/adm/billing-profile:
 *   get:
 *     summary: Datos de facturación de la empresa
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: enterpriseId, schema: { type: integer }, description: Solo ADMIN_DTC (obligatorio) }
 *     responses:
 *       200: { description: "{ success, billingProfile } — null si aún no hay datos" }
 *       403: { description: Rol sin permiso }
 *       404: { description: Un cliente pidió otra empresa }
 *       422: { description: ADMIN_DTC sin ?enterpriseId= }
 *   put:
 *     summary: Crear o actualizar los datos de facturación (solo DTC)
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: enterpriseId, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [legalName, taxId, billingEmail]
 *             properties:
 *               legalName: { type: string, maxLength: 150 }
 *               taxId: { type: string, maxLength: 30 }
 *               billingEmail: { type: string, maxLength: 150 }
 *               billingAddress: { type: string, maxLength: 255 }
 *               country: { type: string, example: CR }
 *     responses:
 *       200: { description: Actualizado }
 *       201: { description: Creado }
 *       403: { description: Rol sin permiso }
 *       422: { description: Validación }
 */
router.get('/billing-profile', canView, billingController.getBillingProfile);
router.put('/billing-profile', dtcOnly, billingController.saveBillingProfile);

module.exports = router;
