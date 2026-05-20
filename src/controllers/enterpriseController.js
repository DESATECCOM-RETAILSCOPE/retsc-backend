const enterpriseService = require('../services/enterpriseService');

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
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message });
  }
};

module.exports = { registerEnterprise };
