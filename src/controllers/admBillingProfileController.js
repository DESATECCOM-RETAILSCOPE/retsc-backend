/**
 * admBillingProfileController.js — Capa HTTP de los datos de facturación (/api/adm/billing-profile).
 *
 * Para qué sirve: toma lo que llega en la petición, llama al servicio y arma la respuesta.
 *   No tiene lógica de negocio.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 */

const service = require('../services/admBillingProfileService');

// Etiqueta con la que este controlador registra sus errores 500.
const TAG = '[adm/billing-profile]';

// Mismo patrón de handleError que el resto de controladores (ver roleController).
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

// GET /api/adm/billing-profile — datos de facturación. Cliente (los suyos) o DTC (?enterpriseId=).
const getBillingProfile = async (req, res) => {
  try {
    const billingProfile = await service.get(req.user, req.query.enterpriseId);
    return res.json({ success: true, billingProfile });
  } catch (err) { return handleError(res, err); }
};

// PUT /api/adm/billing-profile?enterpriseId=… — crea o actualiza. Solo DTC.
// 201 si fue un alta nueva, 200 si se actualizó una existente.
const saveBillingProfile = async (req, res) => {
  try {
    const { billingProfile, created } = await service.save(
      req.user, req.query.enterpriseId, req.body, req.ip,
    );
    return res.status(created ? 201 : 200).json({ success: true, billingProfile, created });
  } catch (err) { return handleError(res, err); }
};

module.exports = { getBillingProfile, saveBillingProfile };
