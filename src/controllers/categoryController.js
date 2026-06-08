const categoryService = require("../services/categoryService");

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error("[category]", err);
  return res.status(status).json({ success: false, message: err.message });
}

// ────────────── Issues 2.x (sin cambios de lógica) ──────────────

// GET /api/categories
const listGlobal = async (req, res) => {
  try {
    const categories = await categoryService.listGlobal();
    return res.json({ success: true, categories });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/enterprises/me/categories
const listByEnterprise = async (req, res) => {
  try {
    const categories = await categoryService.listByEnterprise(
      req.user.enterpriseId,
    );
    return res.json({ success: true, categories });
  } catch (err) {
    return handleError(res, err);
  }
};

// PUT /api/enterprises/me/categories
const replaceForEnterprise = async (req, res) => {
  try {
    const { categoryIds } = req.body;
    const count = await categoryService.replaceForEnterprise(
      req.user.enterpriseId,
      categoryIds,
    );
    return res.json({
      success: true,
      count,
      message: "Selección de categorías actualizada.",
    });
  } catch (err) {
    return handleError(res, err);
  }
};

// ────────────── Issue 3: árbol de categorías ──────────────

// GET /api/categories/roots
const getRoots = async (req, res) => {
  try {
    const categories = await categoryService.getRoots();
    return res.json({ success: true, categories });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/categories/:id/children
const getChildren = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });
    const categories = await categoryService.getChildren(id);
    return res.json({ success: true, categories });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/categories/:id
const getById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });
    const category = await categoryService.getById(id);
    return res.json({ success: true, category });
  } catch (err) {
    return handleError(res, err);
  }
};

// POST /api/categories
const createCategory = async (req, res) => {
  try {
    const category = await categoryService.createCategory(req.body);
    return res.status(201).json({ success: true, category });
  } catch (err) {
    return handleError(res, err);
  }
};

// PUT /api/categories/:id
const updateCategory = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });
    const category = await categoryService.updateCategory(id, req.body);
    return res.json({ success: true, category });
  } catch (err) {
    return handleError(res, err);
  }
};

// DELETE /api/categories/:id
const deactivateCategory = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });
    const result = await categoryService.deactivateCategory(id);
    return res.json({
      success: true,
      message: `Categoría desactivada. ${result.descendantsCount} descendiente(s) también desactivado(s).`,
      deactivated: result.deactivated,
    });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/enterprises/me/enterprise-categories
const listCommercialCategories = async (req, res) => {
  try {
    const categories = await categoryService.listCommercialCategories(req.user.enterpriseId);
    return res.json({ success: true, categories });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = {
  listGlobal,
  listByEnterprise,
  replaceForEnterprise,
  listCommercialCategories,
  getRoots,
  getChildren,
  getById,
  createCategory,
  updateCategory,
  deactivateCategory,
};
