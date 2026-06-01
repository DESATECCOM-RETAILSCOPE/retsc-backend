const categoryRepo = require("../repositories/categoryRepo");
const enterpriseCategoryRepo = require("../repositories/enterpriseCategoryRepo");

function svcError(msg, statusCode) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  return err;
}

function toDTO(c) {
  return {
    categoryId: c.Category_id,
    categoryDsc: c.Category_dsc,
    levelNo: c.level_no,
    parentCategoryId: c.parent_category_id ?? null,
    isSmartDtc: c.is_smart_dtc === true || c.is_smart_dtc === 1,
    status: c.status,
  };
}

// ────────────── Issues 2.x (corregidos) ──────────────

const listGlobal = async () => {
  const cats = await categoryRepo.listActive();
  return cats.map(toDTO);
};

const listByEnterprise = async (enterpriseId) => {
  const relations = await enterpriseCategoryRepo.findByEnterprise(enterpriseId);
  const enriched = await Promise.all(
    relations.map(async (r) => {
      const cat = await categoryRepo.findById(r.Category_id);
      return cat ? toDTO(cat) : null;
    }),
  );
  return enriched.filter(Boolean);
};

const replaceForEnterprise = async (enterpriseId, categoryIds) => {
  if (!Array.isArray(categoryIds))
    throw svcError("categoryIds debe ser un array", 400);
  for (const id of categoryIds) {
    const cat = await categoryRepo.findById(id);
    if (!cat || cat.status !== "ACTIVE") {
      throw svcError(
        `La categoría con id ${id} no existe o no está activa.`,
        400,
      );
    }
  }
  await enterpriseCategoryRepo.replaceForEnterprise(enterpriseId, categoryIds);
  return categoryIds.length;
};

// ────────────── Issue 3: árbol de categorías ──────────────

const getRoots = async () => {
  const cats = await categoryRepo.findRoots();
  return cats.map(toDTO);
};

const getChildren = async (categoryId) => {
  const parent = await categoryRepo.findById(categoryId);
  if (!parent) throw svcError("Categoría no encontrada", 404);
  if (parent.status !== "ACTIVE") throw svcError("Categoría inactiva", 400);
  const children = await categoryRepo.findChildren(categoryId);
  return children.map(toDTO);
};

const getById = async (categoryId) => {
  const cat = await categoryRepo.findById(categoryId);
  if (!cat) throw svcError("Categoría no encontrada", 404);
  return toDTO(cat);
};

const createCategory = async (payload) => {
  const { categoryDsc, parentCategoryId = null, isSmartDtc = false } = payload;

  if (!categoryDsc || !categoryDsc.trim()) {
    throw svcError("categoryDsc es requerido", 400);
  }

  if (categoryDsc.trim().length > 50) {
    throw svcError("categoryDsc no puede superar 50 caracteres", 400);
  }

  let levelNo = 0;
  if (parentCategoryId !== null) {
    const parent = await categoryRepo.findById(parentCategoryId);
    if (!parent) throw svcError("La categoría padre no existe", 404);
    if (parent.status !== "ACTIVE") {
      throw svcError("La categoría padre está inactiva", 400);
    }
    levelNo = parent.level_no + 1;
  }

  const inserted = await categoryRepo.insert({
    Category_dsc: categoryDsc.trim().toUpperCase(),
    level_no: levelNo,
    parent_category_id: parentCategoryId,
    is_smart_dtc: isSmartDtc ? 1 : 0,
    status: "ACTIVE",
  });

  return toDTO(inserted);
};

const updateCategory = async (categoryId, payload) => {
  const { categoryDsc, isSmartDtc, parentCategoryId, status } = payload;

  const existing = await categoryRepo.findById(categoryId);
  if (!existing) throw svcError("Categoría no encontrada", 404);

  const partial = {};

  if (categoryDsc !== undefined) {
    if (!categoryDsc.trim())
      throw svcError("categoryDsc no puede estar vacío", 400);
    if (categoryDsc.trim().length > 50)
      throw svcError("categoryDsc no puede superar 50 caracteres", 400);
    partial.Category_dsc = categoryDsc.trim().toUpperCase();
  }

  if (isSmartDtc !== undefined) {
    partial.is_smart_dtc = isSmartDtc ? 1 : 0;
  }

  // ← Fix: status ahora se acepta y valida
  if (status !== undefined) {
    const validStatuses = ["ACTIVE", "INACTIVE"];
    if (!validStatuses.includes(status)) {
      throw svcError("status debe ser ACTIVE o INACTIVE", 400);
    }
    partial.status = status;
  }

  if (parentCategoryId !== undefined) {
    if (parentCategoryId === categoryId) {
      throw svcError("Una categoría no puede ser padre de sí misma", 400);
    }
    if (parentCategoryId !== null) {
      const newParent = await categoryRepo.findById(parentCategoryId);
      if (!newParent) throw svcError("La categoría padre no existe", 404);
      if (newParent.status !== "ACTIVE")
        throw svcError("La categoría padre está inactiva", 400);

      const descendants = await categoryRepo.findActiveDescendants(categoryId);
      if (descendants.includes(parentCategoryId)) {
        throw svcError(
          "No se puede mover una categoría a uno de sus propios descendientes",
          400,
        );
      }

      partial.parent_category_id = parentCategoryId;
      partial.level_no = newParent.level_no + 1;
    } else {
      partial.parent_category_id = null;
      partial.level_no = 0;
    }
  }

  if (Object.keys(partial).length === 0) {
    return toDTO(existing);
  }

  const updated = await categoryRepo.update(categoryId, partial);
  return toDTO(updated ?? existing);
};

const deactivateCategory = async (categoryId) => {
  const existing = await categoryRepo.findById(categoryId);
  if (!existing) throw svcError("Categoría no encontrada", 404);
  if (existing.status === "INACTIVE") {
    throw svcError("La categoría ya está inactiva", 400);
  }

  const descendantIds = await categoryRepo.findActiveDescendants(categoryId);

  if (descendantIds.length > 0) {
    await categoryRepo.updateManyStatus(descendantIds, "INACTIVE");
  }

  await categoryRepo.update(categoryId, { status: "INACTIVE" });

  return {
    deactivated: 1 + descendantIds.length,
    categoryId,
    descendantsCount: descendantIds.length,
  };
};

module.exports = {
  listGlobal,
  listByEnterprise,
  replaceForEnterprise,
  getRoots,
  getChildren,
  getById,
  createCategory,
  updateCategory,
  deactivateCategory,
};
