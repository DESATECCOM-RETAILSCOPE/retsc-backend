/**
 * admRoutes.js — Rutas del módulo administrativo (/api/adm): contrato, datos de facturación,
 *   facturas y pagos.
 *
 * Para qué sirve: declara qué rutas existen y qué roles pueden usarlas. El control de
 *   acceso real vive aquí y en el servicio (admScope); ocultar botones en la pantalla
 *   no cuenta como seguridad.
 * Dependencias externas pendientes:
 *   // TODO: confirmar con María qué roles de la empresa cliente pueden ver el contrato y
 *   //       los datos de facturación. Hoy: ADMIN y GERENCIA (información financiera).
 *   //       Se puede cambiar sin tocar código con la variable ADM_CLIENT_VIEW_ROLES.
 * TODO conocidos:
 *   // TODO: agregar aquí las rutas de OC, notas de cobro, documentos, antigüedad y
 *   //       bitácora en los pasos siguientes del módulo (facturas y pagos ya están).
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
const invoiceController = require('../controllers/admInvoiceController');
const paymentController = require('../controllers/admPaymentController');

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

/**
 * @swagger
 * /api/adm/invoices:
 *   get:
 *     summary: Facturas con saldo, vencimiento y estado de pago
 *     description: >
 *       Lee de la vista RETSC_ADM_V_INVOICE_BALANCE (excluye facturas ANULADA), ordenadas por
 *       vencimiento ascendente. Cliente = su empresa (del token). ADMIN_DTC debe indicar ?enterpriseId=.
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: enterpriseId, schema: { type: integer }, description: Solo ADMIN_DTC (obligatorio). Para un cliente, otra empresa responde 404. }
 *       - { in: query, name: status, schema: { type: string, enum: [REGISTRADA, ENVIADA, EN_DISPUTA] } }
 *       - { in: query, name: currency, schema: { type: string, enum: [CRC, USD] } }
 *       - { in: query, name: overdue, schema: { type: string, enum: ['1', '0'] }, description: "1 = solo vencidas (Days_overdue > 0)" }
 *       - { in: query, name: dueWithinDays, schema: { type: integer, minimum: 0, maximum: 366 }, description: Vencen entre hoy y hoy + N días (hora de Costa Rica) y tienen saldo }
 *     responses:
 *       200: { description: "{ success, invoices: [{ invoiceId, enterpriseId, contractId, poId, invoiceNumber, issueDate, receivedDate, dueDate, currency, status, totalAmount, paidTotal, balance, paymentStatus, daysOverdue, agingBucket }] }" }
 *       401: { description: Sin token o token inválido }
 *       403: { description: Rol sin permiso }
 *       404: { description: Un cliente pidió otra empresa }
 *       422: { description: "ADMIN_DTC sin ?enterpriseId= o filtro inválido. { success:false, message, field }" }
 *   post:
 *     summary: Registrar una factura (solo DTC)
 *     description: >
 *       La empresa, la moneda esperada y el plazo de crédito salen del CONTRATO. Due_date la calcula
 *       la base (Received_date o Issue_date + Credit_days) y viene en la respuesta. Si la factura lleva
 *       la orden de compra exactamente a su monto, la OC pasa a CERRADA en la misma transacción.
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contractId, invoiceNumber, issueDate, subtotal, taxAmount, totalAmount, currency]
 *             properties:
 *               contractId: { type: integer, description: Contrato ACTIVO }
 *               poId: { type: integer, description: Obligatoria si el contrato exige OC; debe estar VALIDADA }
 *               invoiceNumber: { type: string, maxLength: 50 }
 *               invoiceKey: { type: string, maxLength: 60 }
 *               issueDate: { type: string, format: date }
 *               receivedDate: { type: string, format: date }
 *               periodFrom: { type: string, format: date }
 *               periodTo: { type: string, format: date }
 *               subtotal: { type: number }
 *               taxAmount: { type: number }
 *               totalAmount: { type: number, description: Debe ser subtotal + taxAmount }
 *               currency: { type: string, enum: [CRC, USD] }
 *     responses:
 *       201: { description: "{ success, invoice, poClosed }" }
 *       403: { description: Rol sin permiso }
 *       422: { description: "Validación (contrato, moneda, total, OC, saldo de OC, número duplicado). { success:false, message, field }" }
 */
router.get('/invoices', canView, invoiceController.listInvoices);
router.post('/invoices', dtcOnly, invoiceController.createInvoice);

/**
 * @swagger
 * /api/adm/invoices/{id}/status:
 *   post:
 *     summary: Cambiar el estado de una factura (solo DTC)
 *     description: >
 *       REGISTRADA→ENVIADA|EN_DISPUTA|ANULADA, ENVIADA→EN_DISPUTA|ANULADA, EN_DISPUTA→ENVIADA|ANULADA.
 *       ANULADA es definitiva, exige reason y no se permite si la factura tiene pagos APLICADO.
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [ENVIADA, EN_DISPUTA, ANULADA] }
 *               reason: { type: string, maxLength: 255, description: Obligatorio si status = ANULADA }
 *     responses:
 *       200: { description: "{ success, invoice }" }
 *       403: { description: Rol sin permiso }
 *       404: { description: Factura no encontrada }
 *       422: { description: Transición no permitida, falta el motivo o tiene pagos aplicados }
 */
router.post('/invoices/:id/status', dtcOnly, invoiceController.changeInvoiceStatus);

/**
 * @swagger
 * /api/adm/invoices/{id}/payments:
 *   get:
 *     summary: Pagos de una factura (solo DTC)
 *     description: Incluye pagos APLICADO y ANULADO. Endpoint extra (no está en la tabla de la spec).
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ success, payments: [] }" }
 *       403: { description: Rol sin permiso }
 *       404: { description: Factura no encontrada }
 *   post:
 *     summary: Registrar un pago manual (solo DTC)
 *     description: >
 *       La moneda debe ser la de la factura y la suma de pagos APLICADO no puede superar el total.
 *       La respuesta trae el saldo actualizado de la factura.
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentDate, amount, currency, method]
 *             properties:
 *               paymentDate: { type: string, format: date }
 *               amount: { type: number, exclusiveMinimum: 0, description: Máximo 2 decimales }
 *               currency: { type: string, enum: [CRC, USD] }
 *               method: { type: string, enum: [TRANSFERENCIA, TARJETA, SINPE, OTRO] }
 *               reference: { type: string, maxLength: 100 }
 *               bank: { type: string, maxLength: 80 }
 *     responses:
 *       201: { description: "{ success, payment, invoiceBalance: { invoiceId, totalAmount, paidTotal, balance, paymentStatus } }" }
 *       403: { description: Rol sin permiso }
 *       404: { description: Factura no encontrada }
 *       422: { description: "Factura ANULADA, moneda distinta o el pago supera el saldo. { success:false, message, field }" }
 */
router.get('/invoices/:id/payments', dtcOnly, paymentController.listPayments);
router.post('/invoices/:id/payments', dtcOnly, paymentController.createPayment);

/**
 * @swagger
 * /api/adm/payments/{id}/void:
 *   post:
 *     summary: Anular un pago con motivo (solo DTC)
 *     description: El pago debe estar APLICADO. Nunca se borra. Devuelve el saldo actualizado de la factura.
 *     tags: [Administración]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, maxLength: 255 }
 *     responses:
 *       200: { description: "{ success, payment, invoiceBalance }" }
 *       403: { description: Rol sin permiso }
 *       404: { description: Pago no encontrado }
 *       422: { description: Falta el motivo o el pago ya está ANULADO }
 */
router.post('/payments/:id/void', dtcOnly, paymentController.voidPayment);

module.exports = router;
