/**
 * admBillingProfileController.js — Capa HTTP de los datos de facturación (/api/adm/billing-profile).
 *
 * Para qué sirve: toma lo que llega en la petición, llama al servicio y arma la respuesta.
 *   No tiene lógica de negocio.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 */

const service = require('../services/admBillingProfileService');

// Mismo patrón de handleError que el resto de controladores (ver roleController).
function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[adm/billing-profile]', err);
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
