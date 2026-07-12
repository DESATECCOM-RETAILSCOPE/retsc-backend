const enterpriseService = require('../services/enterpriseService');

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
// NOTA: RETSC_OP_ROLES has no platform-wide admin role — "Admin" (checked by
// requireAdmin on this route) is assigned per user-enterprise relation, so
// every enterprise's own Admin would otherwise see every other enterprise
// too. Always scope the result to the caller's own linked enterprises.
const listEnterprises = async (req, res) => {
  try {
    const enterprises = await enterpriseService.listByUser(req.user.userId);
    return res.json({ success: true, enterprises });
  } catch (err) { return handleError(res, err); }
};

// GET /api/enterprises/:id
const getEnterprise = async (req, res) => {
  try {
    const enterprise = await enterpriseService.findById(Number(req.params.id));
    return res.json({ success: true, enterprise });
  } catch (err) { return handleError(res, err); }
};

// POST /api/enterprises/create
const createEnterprise = async (req, res) => {
  try {
    const enterprise = await enterpriseService.createEnterprise(req.body);
    return res.status(201).json({ success: true, enterprise });
  } catch (err) { return handleError(res, err); }
};

// PUT /api/enterprises/:id
const updateEnterprise = async (req, res) => {
  try {
    const enterprise = await enterpriseService.updateEnterprise(Number(req.params.id), req.body);
    return res.json({ success: true, enterprise });
  } catch (err) { return handleError(res, err); }
};

module.exports = { registerEnterprise, listEnterprises, getEnterprise, createEnterprise, updateEnterprise };
