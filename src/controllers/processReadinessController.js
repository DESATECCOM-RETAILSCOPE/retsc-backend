// Controller para GET /api/readiness — ver processReadinessService.js para el contexto
// completo (crash de cumplimiento_pct NULL, 2026-10-23).

const processReadinessService = require('../services/processReadinessService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[processReadiness]', err);
  return res.status(status).json({ success: false, message: err.message });
}

// GET /api/readiness?retailerId=&categoryId= — enterpriseId sale del JWT, nunca del query.
const checkReadiness = async (req, res) => {
  try {
    const retailerId = parseInt(req.query.retailerId, 10);
    const categoryId = parseInt(req.query.categoryId, 10);
    if (isNaN(retailerId) || isNaN(categoryId)) {
      return res.status(400).json({
        success: false,
        message: 'retailerId y categoryId son requeridos y deben ser numéricos.',
      });
    }

    const result = await processReadinessService.checkReadiness({
      enterpriseId: req.user.enterpriseId,
      retailerId,
      categoryId,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { checkReadiness };
