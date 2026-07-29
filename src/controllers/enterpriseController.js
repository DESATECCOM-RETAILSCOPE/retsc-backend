const enterpriseService = require('../services/enterpriseService');
const { ROLES, normalizeRole } = require('../config/roles');

function isAdminDtc(req) {
  return normalizeRole(req.user?.roleName) === ROLES.ADMIN_DTC;
}

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[enterprise]', err);
  return res.status(status).json({ success: false, message: err.message });
}

const registerEnterprise = async (req, res) => {
  try {
    const result = await enterpriseService.registerEnterprise(req.body);

    console.log(
      `[enterprise] created Enterprise_id=${result.enterpriseId}, user=${result.isNewUser ? 'NEW' : 'EXISTING'}`
    );

    const response = {
      success:      true,
      enterpriseId: result.enterpriseId,
      userId:       result.userId,
      isNewUser:    result.isNewUser,
    };

    if (result.isNewUser) {
      response.generatedPassword = result.generatedPassword;
      response.message = 'Empresa registrada exitosamente. Entregar el password al administrador; no se mostrará de nuevo.';
    } else {
      response.message = 'Empresa registrada exitosamente. El administrador ya tenía cuenta en el sistema; mantiene su password actual.';
    }

    return res.status(201).json(response);
  } catch (err) { return handleError(res, err); }
};

// GET /api/enterprises/list
// Decisión de negocio (feedback dueña, 1 Jul): ADMIN_DTC (superusuario) ve
// TODAS las empresas; un ADMIN normal solo ve SU PROPIA empresa (la de su
// token, no las que "listByUser" encuentre por relación — un ADMIN administra
// una sola empresa por diseño). Mismo formato de respuesta (array) en ambos casos.
const listEnterprises = async (req, res) => {
  try {
    if (isAdminDtc(req)) {
      const enterprises = await enterpriseService.listAll();
      return res.json({ success: true, enterprises });
    }
    const own = await enterpriseService.findById(req.user.enterpriseId);
    return res.json({ success: true, enterprises: [own] });
  } catch (err) { return handleError(res, err); }
};

// GET /api/enterprises/:id — ADMIN_DTC accede a cualquiera; ADMIN solo a la suya.
const getEnterprise = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!isAdminDtc(req) && id !== req.user.enterpriseId) {
      return res.status(403).json({ success: false, message: 'No tiene permiso para ver esta empresa.' });
    }
    const enterprise = await enterpriseService.findById(id);
    return res.json({ success: true, enterprise });
  } catch (err) { return handleError(res, err); }
};

// POST /api/enterprises/create
// CONFIRMAR con la dueña: se asume que crear empresas cliente es función
// exclusiva de DTC — la ruta ya está restringida a ADMIN_DTC vía
// requireRole en enterpriseRoutes.js, esta función no necesita el chequeo
// porque el middleware ya lo filtró antes de llegar acá.
const createEnterprise = async (req, res) => {
  try {
    const enterprise = await enterpriseService.createEnterprise(req.body);
    return res.status(201).json({ success: true, enterprise });
  } catch (err) { return handleError(res, err); }
};

// PUT /api/enterprises/:id — misma regla de acceso que el GET por id.
const updateEnterprise = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!isAdminDtc(req) && id !== req.user.enterpriseId) {
      return res.status(403).json({ success: false, message: 'No tiene permiso para modificar esta empresa.' });
    }
    const enterprise = await enterpriseService.updateEnterprise(id, req.body);
    return res.json({ success: true, enterprise });
  } catch (err) { return handleError(res, err); }
};

module.exports = { registerEnterprise, listEnterprises, getEnterprise, createEnterprise, updateEnterprise };
