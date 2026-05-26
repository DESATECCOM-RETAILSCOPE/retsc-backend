const categoryRepo         = require('../repositories/categoryRepo');
const enterpriseCategoryRepo = require('../repositories/enterpriseCategoryRepo');

function svcError(msg, statusCode) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  return err;
}

// ── 2.1 ──────────────────────────────────────────────────────────────────────
const listGlobal = async () => {
  const cats = await categoryRepo.listActive();
  return cats.map(c => ({ categoryId: c.Category_id, categoryDsc: c.Category_dsc, status: c.Status }));
};

// ── 2.2 ──────────────────────────────────────────────────────────────────────
const listByEnterprise = async (enterpriseId) => {
  const relations = await enterpriseCategoryRepo.findByEnterprise(enterpriseId);
  const enriched = await Promise.all(
    relations.map(async (r) => {
      const cat = await categoryRepo.findById(r.Category_id);
      return cat ? { categoryId: cat.Category_id, categoryDsc: cat.Category_dsc } : null;
    })
  );
  return enriched.filter(Boolean);
};

// ── 2.3 ──────────────────────────────────────────────────────────────────────
const replaceForEnterprise = async (enterpriseId, categoryIds) => {
  if (!Array.isArray(categoryIds)) throw svcError('categoryIds debe ser un array', 400);

  // Validar que cada categoryId exista y esté activa
  for (const id of categoryIds) {
    const cat = await categoryRepo.findById(id);
    if (!cat || cat.Status !== 1) throw svcError(`La categoría con id ${id} no existe o no está activa.`, 400);
  }

  await enterpriseCategoryRepo.replaceForEnterprise(enterpriseId, categoryIds);
  return categoryIds.length;
};

module.exports = { listGlobal, listByEnterprise, replaceForEnterprise };
