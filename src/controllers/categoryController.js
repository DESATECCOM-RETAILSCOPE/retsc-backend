const categoryService             = require("../services/categoryService");
const aiInfrastructureService     = require("../services/aiInfrastructureService");

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error("[category]", err);
  return res.status(status).json({ success: false, message: err.message });
}

// ────────────── Issues 2.x ──────────────

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

// PUT /api/enterprises/me/categories  — reemplaza la selección: agrega lo nuevo,
// quita lo que ya no viene en categoryIds, no duplica lo que sigue igual.
const replaceForEnterprise = async (req, res) => {
  try {
    const { categoryIds } = req.body;
    const result = await categoryService.replaceForEnterprise(
      req.user.enterpriseId,
      categoryIds,
    );

    const parts = [];
    if (result.added > 0) parts.push(`${result.added} agregada(s)`);
    if (result.removed > 0) parts.push(`${result.removed} quitada(s)`);

    return res.json({
      success: true,
      added: result.added,
      removed: result.removed,
      alreadyExisted: result.alreadyExisted,
      message: result.changed
        ? `Categoría(s): ${parts.join(", ")}.`
        : "Las categorías seleccionadas ya estaban guardadas.",
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

// POST /api/categories/:id/retry-ai-infra  (solo Admin)
// Reintenta el provisioning de infraestructura IA para una categoría smart que
// quedó en estado PENDING o PENDING_AZURE (ej. por fallo temporal de Azure).
const retryAiInfra = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });

    const result = await aiInfrastructureService.retryForCategory(id);

    // Mapear el status interno a un mensaje más descriptivo para el cliente
    const messages = {
      PROVISIONED:    'Infraestructura provisionada exitosamente.',
      PENDING:        'Reintento parcial: algunos componentes siguen pendientes. Ver campo errors.',
      ALREADY_EXISTS: 'La infraestructura ya estaba provisionada correctamente.',
      ERROR:          'Error al intentar el provisioning.',
    };

    const httpStatus = result.status === 'ERROR' ? 400 : 200;
    return res.status(httpStatus).json({
      success: result.status !== 'ERROR',
      message: messages[result.status] ?? result.status,
      ...result,
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

// GET /api/enterprises/me/enterprise-categories/smart
// Categorías inteligentes del enterprise para dropdowns de Góndola y Carga SKU.
// Ya deduplicadas: si la empresa seleccionó un padre con varias hijas smart, cada
// hija aparece UNA sola vez (GROUP BY + MIN en enterpriseCategoryRepo.listSmartForEnterprise).
// Contrato de respuesta:
//   { success: true, categories: [{ enterpriseCategoryId, categoryId, categoryDsc,
//                                    parentCategoryId, parentDsc, levelNo }] }
// IMPORTANTE (Issue B4/QA): la pantalla de Fotos de Góndola debe consumir este endpoint,
// NO GET /api/categories filtrado por is_smart_dtc en el cliente — ese devuelve TODAS
// las categorías DTC globales (no las de la empresa) y es ahí donde el padre puede
// aparecer repetido en el dropdown si el cliente no dedupea.
const listSmartByEnterprise = async (req, res) => {
  try {
    const categories = await categoryService.listSmartByEnterprise(req.user.enterpriseId);
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
  listSmartByEnterprise,
  getRoots,
  getChildren,
  getById,
  createCategory,
  updateCategory,
  deactivateCategory,
  retryAiInfra,
};
