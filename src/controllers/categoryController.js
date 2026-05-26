const categoryService = require('../services/categoryService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[category]', err);
  return res.status(status).json({ success: false, message: err.message });
}

// GET /api/categories
const listGlobal = async (req, res) => {
  try {
    const categories = await categoryService.listGlobal();
    return res.json({ success: true, categories });
  } catch (err) { return handleError(res, err); }
};

// GET /api/enterprises/me/categories
const listByEnterprise = async (req, res) => {
  try {
    const categories = await categoryService.listByEnterprise(req.user.enterpriseId);
    return res.json({ success: true, categories });
  } catch (err) { return handleError(res, err); }
};

// PUT /api/enterprises/me/categories
const replaceForEnterprise = async (req, res) => {
  try {
    const { categoryIds } = req.body;
    const count = await categoryService.replaceForEnterprise(req.user.enterpriseId, categoryIds);
    return res.json({ success: true, count, message: 'Selección de categorías actualizada.' });
  } catch (err) { return handleError(res, err); }
};

module.exports = { listGlobal, listByEnterprise, replaceForEnterprise };
