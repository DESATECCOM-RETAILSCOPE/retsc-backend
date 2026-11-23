/**
 * admInvoiceController.js — Capa HTTP de las facturas (/api/adm/invoices*).
 *
 * Para qué sirve: toma lo que llega en la petición (token, query, cuerpo), llama al
 *   servicio y arma la respuesta { success, ... }. No tiene lógica de negocio.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos:
 *   // TODO: recibir PDF/XML (multipart/form-data) cuando exista el servicio de documentos.
 */

const service = require('../services/admInvoiceService');

// Etiqueta con la que este controlador registra sus errores 500.
const TAG = '[adm/invoice]';

// Convierte un error del servicio en respuesta HTTP. Mismo patrón que admContractController:
// el 500 se registra en consola; el resto son errores esperados con su statusCode.
// Los errores 500 responden un mensaje fijo y se registran sin datos sensibles (ver abajo).
function handleError(res, err) {
  const status = err?.statusCode || 500;

  // Errores del servidor (500 o más): NUNCA se devuelve err.message ni err.payload al navegador,
  // porque un error del driver SQL trae nombres de servidor, usuario, tablas y columnas.
  if (status >= 500) {
    // ¿Es un error de SQL? Los de mssql traen `number` (código de SQL Server) u `originalError`.
    const isSqlError = err?.number != null || err?.originalError != null;
    // Se registra un objeto SEGURO: nada del objeto err completo, ni su stack, ni req.body.
    const logEntry = { tag: TAG, name: err?.name ?? null, code: err?.code ?? err?.number ?? null };
    // El mensaje solo se registra si NO es de SQL (por ejemplo un TypeError de programación),
    // porque el texto de un error SQL puede traer datos de conexión.
    if (!isSqlError) logEntry.message = err?.message ?? String(err);
    console.error(logEntry);
    return res.status(status).json({ success: false, message: 'Error interno del servidor' });
  }

  // Errores esperados (400-499): igual que antes. err.payload trae datos extra, por ejemplo
  // { field } para marcar el campo en pantalla.
  return res.status(status).json({ success: false, message: err.message, ...(err.payload ?? {}) });
}

// GET /api/adm/invoices — facturas con saldo. Cliente (la suya) o DTC (?enterpriseId=).
const listInvoices = async (req, res) => {
  try {
    const invoices = await service.list(req.user, req.query);
    return res.json({ success: true, invoices });
  } catch (err) { return handleError(res, err); }
};

// POST /api/adm/invoices — registra una factura. Solo DTC.
// poClosed = true si la orden de compra quedó CERRADA con esta factura.
const createInvoice = async (req, res) => {
  try {
    const { invoice, poClosed } = await service.create(req.user, req.body, req.ip);
    return res.status(201).json({ success: true, invoice, poClosed });
  } catch (err) { return handleError(res, err); }
};

// POST /api/adm/invoices/:id/status — cambia el estado (ENVIADA, EN_DISPUTA, ANULADA). Solo DTC.
const changeInvoiceStatus = async (req, res) => {
  try {
    const invoice = await service.changeStatus(req.user, req.params.id, req.body, req.ip);
    return res.json({ success: true, invoice });
  } catch (err) { return handleError(res, err); }
};

module.exports = { listInvoices, createInvoice, changeInvoiceStatus };
