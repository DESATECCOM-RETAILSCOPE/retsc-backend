const productRepo = require('../repositories/productRepo');

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

module.exports = { listByEnterprise, listCategoriesWithProducts };
