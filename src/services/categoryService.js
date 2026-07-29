const categoryRepo              = require("../repositories/categoryRepo");
const enterpriseCategoryRepo   = require("../repositories/enterpriseCategoryRepo");
const aiInfrastructureService  = require("./aiInfrastructureService");

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

// ────────────── Algoritmo de resolución para IA ──────────────

async function resolveCategory(selectedCategoryId) {
  const cat = await categoryRepo.findById(selectedCategoryId);
  if (!cat) return [];

  // Caso 1: DIRECT — la categoría seleccionada es inteligente
  const isSmartDtc = cat.is_smart_dtc === 1 || cat.is_smart_dtc === true;
  if (isSmartDtc) {
    return [
      {
        selected_category_id: selectedCategoryId,
        resolved_category_id: selectedCategoryId,
        resolution_type: "DIRECT",
      },
    ];
  }

  // Caso 2: EXPAND — buscar descendientes con is_smart_dtc=1
  const allDescendants =
    await categoryRepo.findActiveDescendants(selectedCategoryId);
  const smartDescendants = [];
  for (const descId of allDescendants) {
    const desc = await categoryRepo.findById(descId);
    if (desc && (desc.is_smart_dtc === 1 || desc.is_smart_dtc === true)) {
      smartDescendants.push(descId);
    }
  }

  if (smartDescendants.length > 0) {
    return smartDescendants.map((resolvedId) => ({
      selected_category_id: selectedCategoryId,
      resolved_category_id: resolvedId,
      resolution_type: "EXPAND",
    }));
  }

  // Caso 3: COLLAPSE — subir al padre hasta encontrar uno con is_smart_dtc=1
  let current = cat;
  while (current.parent_category_id) {
    const parent = await categoryRepo.findById(current.parent_category_id);
    if (!parent) break;
    const parentIsSmart =
      parent.is_smart_dtc === 1 || parent.is_smart_dtc === true;
    if (parentIsSmart) {
      return [
        {
          selected_category_id: selectedCategoryId,
          resolved_category_id: parent.Category_id,
          resolution_type: "COLLAPSE",
        },
      ];
    }
    current = parent;
  }

  // Caso 4: No se encontró ninguna categoría inteligente
  return [
    {
      selected_category_id: selectedCategoryId,
      resolved_category_id: null,
      resolution_type: null,
    },
  ];
}

// ────────────── Issues 2.x ──────────────

const listGlobal = async () => {
  const cats = await categoryRepo.listActive();
  return cats.map(toDTO);
};

const listByEnterprise = async (enterpriseId) => {
  const relations = await enterpriseCategoryRepo.findByEnterprise(enterpriseId);
  // Deduplicar por selected_category_id (puede haber varios resolved por uno seleccionado)
  const uniqueSelectedIds = [
    ...new Set(relations.map((r) => r.selected_category_id)),
  ];
  const enriched = await Promise.all(
    uniqueSelectedIds.map(async (selectedId) => {
      const cat = await categoryRepo.findById(selectedId);
      return cat ? toDTO(cat) : null;
    }),
  );
  return enriched.filter(Boolean);
};

// Reemplaza la selección completa de la empresa: agrega lo nuevo, inactiva lo que ya no
// viene en categoryIds, y deja intacto lo que sigue presente en ambos lados.
// NOTA: antes esta función solo agregaba y nunca inactivaba nada — un PUT con una
// categoría removida del array no la borraba (bug reportado: no se puede quitar una
// categoría desde la pantalla de selección). Corregido para que PUT reemplace de verdad.
const replaceForEnterprise = async (enterpriseId, categoryIds) => {
  if (!Array.isArray(categoryIds)) {
    throw svcError("categoryIds debe ser un array", 400);
  }

  // Validar que cada categoría existe y está activa
  for (const id of categoryIds) {
    const cat = await categoryRepo.findById(id);
    if (!cat || cat.status !== "ACTIVE") {
      throw svcError(
        `La categoría con id ${id} no existe o no está activa.`,
        400,
      );
    }
  }

  // Categorías que la empresa ya tiene guardadas (ACTIVE)
  const currentRelations =
    await enterpriseCategoryRepo.findByEnterprise(enterpriseId);
  const alreadySelected = new Set(
    currentRelations.map((r) => r.selected_category_id),
  );
  const requested = new Set(categoryIds);

  // Nuevas: pedidas pero todavía no guardadas
  const newCategoryIds = categoryIds.filter((id) => !alreadySelected.has(id));
  // Removidas: guardadas pero ya no están en la selección enviada
  const removedCategoryIds = [...alreadySelected].filter(
    (id) => !requested.has(id),
  );

  if (newCategoryIds.length === 0 && removedCategoryIds.length === 0) {
    return {
      added: 0,
      removed: 0,
      alreadyExisted: categoryIds.length,
      changed: false,
    };
  }

  // Resolver las categorías inteligentes solo para las nuevas
  const records = [];
  for (const id of newCategoryIds) {
    const resolved = await resolveCategory(id);
    records.push(...resolved);
  }

  await enterpriseCategoryRepo.syncForEnterprise(enterpriseId, {
    toRemoveSelectedIds: removedCategoryIds,
    toAddRecords: records,
  });

  return {
    added: newCategoryIds.length,
    removed: removedCategoryIds.length,
    alreadyExisted: categoryIds.length - newCategoryIds.length,
    changed: true,
  };
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

  const dto = toDTO(inserted);

  // Provisioning de infraestructura IA en background (fire-and-forget).
  // La respuesta al usuario NO espera este proceso.
  // Si falla, queda PENDING_AZURE o PENDING y puede reintentarse con
  // POST /api/categories/:id/retry-ai-infra (solo Admin).
  if (dto.isSmartDtc) {
    aiInfrastructureService
      .provisionForCategory({ categoryId: dto.categoryId, categoryName: dto.categoryDsc })
      .then((result) => {
        console.log('[aiInfra] provisioning completado', { categoryId: dto.categoryId, ...result });
      })
      .catch((err) => {
        // Este catch solo captura errores inesperados del orquestador mismo.
        // Los errores de Azure ya son manejados internamente por aiInfrastructureService.
        console.error('[aiInfra] error inesperado en provisioning', { categoryId: dto.categoryId, err });
      });
  }

  return dto;
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
  const dto = toDTO(updated ?? existing);

  // Si la actualización activó is_smart_dtc por primera vez, provisionar infraestructura IA.
  // Condición: el campo cambió de 0→1 en esta operación.
  const wasSmartBefore = existing.is_smart_dtc === 1 || existing.is_smart_dtc === true;
  if (dto.isSmartDtc && !wasSmartBefore) {
    aiInfrastructureService
      .provisionForCategory({ categoryId: dto.categoryId, categoryName: dto.categoryDsc })
      .then((result) => {
        console.log('[aiInfra] provisioning por actualización', { categoryId: dto.categoryId, ...result });
      })
      .catch((err) => {
        console.error('[aiInfra] error inesperado al actualizar categoría', { categoryId: dto.categoryId, err });
      });
  }

  return dto;
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

const listCommercialCategories = async (enterpriseId) => {
  const rows =
    await enterpriseCategoryRepo.listCommercialCategories(enterpriseId);
  return rows.map((r) => ({
    id: r.enterprise_category_id,
    enterpriseCategoryId: r.enterprise_category_id,
    name: r.enterprise_category_dsc,
    enterprise_category_dsc: r.enterprise_category_dsc,
  }));
};

// Categorías inteligentes del enterprise para formularios de Góndola y Carga SKU.
// Devuelve las smart categories únicas con metadatos de padre para que el upload
// service pueda aplicar la regla "Si me da un hijo, grabar el papá".
const listSmartByEnterprise = async (enterpriseId) => {
  const rows = await enterpriseCategoryRepo.listSmartForEnterprise(enterpriseId);
  return rows.map((r) => ({
    enterpriseCategoryId: r.enterprise_category_id,
    categoryId: r.category_id,
    categoryDsc: r.category_dsc,
    parentCategoryId: r.parent_category_id ?? null,
    parentDsc: r.parent_dsc ?? null,
    levelNo: r.level_no,
  }));
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
};
