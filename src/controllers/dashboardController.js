// Controller del dashboard (Issue B7).
// Rutas asociadas: /api/dashboard

const dashboardService = require('../services/dashboardService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[dashboard]', err);
  return res.status(status).json({ success: false, message: err.message });
}

// GET /api/dashboard — métricas reales, escopeadas por rol (ver dashboardService.js).
const getDashboard = async (req, res) => {
  try {
    const metrics = await dashboardService.getDashboard(req.user);
    return res.json({ success: true, ...metrics });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { getDashboard };
