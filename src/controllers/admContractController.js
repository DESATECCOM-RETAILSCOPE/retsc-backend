/**
 * admContractController.js — Capa HTTP de los contratos (/api/adm/contract*).
 *
 * Para qué sirve: toma lo que llega en la petición (token, query, cuerpo), llama al
 *   servicio y arma la respuesta { success, ... }. No tiene lógica de negocio.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 */

const service = require('../services/admContractService');

// Etiqueta con la que este controlador registra sus errores 500.
const TAG = '[adm/contract]';

// Convierte un error del servicio en respuesta HTTP. Mismo patrón que roleController:
// cada controlador tiene su propio handleError. El 500 se registra en consola; el resto
// son errores esperados (validación, no encontrado, etc.) y llevan su statusCode.
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

// GET /api/adm/contract — contrato ACTIVO de la empresa. Cliente (la suya) o DTC (?enterpriseId=).
const getActiveContract = async (req, res) => {
  try {
    const contract = await service.getActive(req.user, req.query.enterpriseId);
    return res.json({ success: true, contract });
  } catch (err) { return handleError(res, err); }
};

// GET /api/adm/contracts — todos los contratos de una empresa. Solo DTC (?enterpriseId=).
const listContracts = async (req, res) => {
  try {
    const contracts = await service.list(req.user, req.query.enterpriseId);
    return res.json({ success: true, contracts });
  } catch (err) { return handleError(res, err); }
};

// POST /api/adm/contracts — crea un contrato. Solo DTC. La empresa va en el cuerpo.
const createContract = async (req, res) => {
  try {
    const contract = await service.create(req.user, req.body, req.ip);
    return res.status(201).json({ success: true, contract });
  } catch (err) { return handleError(res, err); }
};

// PUT /api/adm/contracts/:id — edita un contrato. Solo DTC.
const updateContract = async (req, res) => {
  try {
    const contract = await service.update(req.user, req.params.id, req.body, req.ip);
    return res.json({ success: true, contract });
  } catch (err) { return handleError(res, err); }
};

module.exports = { getActiveContract, listContracts, createContract, updateContract };
