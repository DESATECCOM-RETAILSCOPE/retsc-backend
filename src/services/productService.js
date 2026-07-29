const productRepo = require('../repositories/productRepo');
const skuRepo     = require('../repositories/skuRepo');

// categoryName prioriza client_category (la categoría propia del cliente, tal
// como viene en su Excel de carga) por sobre commercial_category_dsc (el árbol
// oficial RETSC_OP_CATEGORIES, una sola categoría por batch de carga — no
// refleja lo que el cliente puso realmente en cada fila). Ver
// docs/PROMPT-fix-carga-sku-brand-category.md para el porqué de esta decisión.
function toProductDTO(row) {
  return {
    productId:         row.product_id,
    skuId:              row.SKU_ID,
    gtin:               row.EAN,
    description:        row.Product_dsc,
    categoryId:         row.Category_id ?? null,
    categoryName:       row.client_category ?? row.commercial_category_dsc ?? null,
    clientCategory:     row.client_category ?? null,
    clientSubcategory:  row.client_subcategory ?? null,
    brand:              row.Brand ?? null,
    supplier:           row.Supplier ?? null,
    volume:             row.volume ?? null,
    relevantFeature:    row.Relevant_feature ?? null,
    status:             row.status,
    primaryImage:       row.image_url ?? null,
  };
}

async function listByEnterprise(enterpriseId, filters = {}) {
  const { categoryId, search, page = 1, limit = 50 } = filters;

  // Paginación resuelta en SQL (OFFSET/FETCH + COUNT(*)) — antes se traía todo
  // el catálogo de la empresa y se paginaba con .slice() en Node.
  // categoryId ya no es un FK numérico — es el texto de client_category (ver
  // productRepo.buildFilters), por eso no se castea a Number.
  const { rows, total } = await productRepo.listByEnterprise(enterpriseId, {
    categoryId: categoryId || undefined,
    search,
    page: Number(page),
    limit: Number(limit),
  });

  const products = rows.map(toProductDTO);

  return { products, total, page: Number(page), limit: Number(limit) };
}

// GET /api/products/categories — categorías propias del cliente (client_category)
// con al menos un SKU cargado por la empresa. categoryId/categoryDsc quedan
// iguales (el mismo texto) porque ya no hay un id numérico de FK — es texto libre.
async function listCategoriesWithProducts(enterpriseId) {
  const rows = await productRepo.listCategoriesWithProducts(enterpriseId);
  return rows.map((r) => ({ categoryId: r.client_category, categoryDsc: r.client_category }));
}

// GET /api/products/global — catálogo global (menú por rol 2026-07-25, ítem "Productos"
// de ADMIN_DTC). A propósito NO reusa toProductDTO de arriba: ese DTO expone brand/
// supplier/clientCategory/etc. de RETSC_OP_ENTERPRISE_PRODUCT_SEG, que esta vista global
// no debe llevar (sin datos de ninguna empresa). skuCount/sampleSkuId reflejan que cada
// fila es un grupo de SKUs (ver PRODUCT_GROUP_KEY_EXPR en skuRepo.js), no un SKU individual.
function toGlobalProductDTO(row) {
  return {
    sampleSkuId:  row.sample_sku_id,
    description:  row.Product_dsc,
    categoryId:   row.detection_category_id ?? null,
    skuCount:     row.sku_count,
    status:       row.status,
    imageStatus:  row.image_status ?? null,
    primaryImage: row.image_url ?? null,
    creationDate: row.creation_date,
  };
}

async function listGlobal(filters = {}) {
  const { search, page = 1, limit = 50 } = filters;
  const { rows, total } = await skuRepo.listGlobalProducts({
    search,
    page: Number(page),
    limit: Number(limit),
  });
  return { products: rows.map(toGlobalProductDTO), total, page: Number(page), limit: Number(limit) };
}

module.exports = { listByEnterprise, listCategoriesWithProducts, listGlobal };
