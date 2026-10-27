// Controller para GET/PUT /api/users/me/preferences — self-service, cualquier usuario
// autenticado (no solo Admin, ver userRoutes.js donde se declara ANTES del gate de Admin).

const userPreferencesService = require('../services/userPreferencesService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[userPreferences]', err);
  return res.status(status).json({ success: false, message: err.message });
}

const getMyPreferences = async (req, res) => {
  try {
    const preferences = await userPreferencesService.getMyPreferences(req.user.userId);
    return res.json({ success: true, preferences });
  } catch (err) {
    return handleError(res, err);
  }
};

const setMyPreferences = async (req, res) => {
  try {
    const preferences = await userPreferencesService.setMyPreferences(req.user.userId, req.body);
    return res.json({ success: true, preferences });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { getMyPreferences, setMyPreferences };
