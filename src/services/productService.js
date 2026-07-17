const productRepo = require('../repositories/productRepo');
const imageRepo   = require('../repositories/imageRepo');

function toProductDTO(row) {
  return {
    productId:    row.product_id,
    skuId:        row.SKU_ID,
    gtin:         row.EAN,
    description:  row.Product_dsc,
    categoryId:   row.Category_id ?? null,
    categoryName: row.commercial_category_dsc ?? null,
    brand:        row.Brand ?? null,
    status:       row.status,
    primaryImage: row.image_url ?? null,
  };
}

async function listByEnterprise(enterpriseId, filters = {}) {
  const { categoryId, search, page = 1, limit = 50 } = filters;

  // Paginación resuelta en SQL (OFFSET/FETCH + COUNT(*)) — antes se traía todo
  // el catálogo de la empresa y se paginaba con .slice() en Node.
  const { rows, total } = await productRepo.listByEnterprise(enterpriseId, {
    categoryId: categoryId ? Number(categoryId) : undefined,
    search,
    page: Number(page),
    limit: Number(limit),
  });

  const products = rows.map(toProductDTO);

  return { products, total, page: Number(page), limit: Number(limit) };
}

// GET /api/products/categories — categorías con al menos un SKU cargado por la empresa.
async function listCategoriesWithProducts(enterpriseId) {
  const rows = await productRepo.listCategoriesWithProducts(enterpriseId);
  return rows.map((r) => ({ categoryId: r.Category_id, categoryDsc: r.Category_dsc }));
}

async function findById(productId, enterpriseId) {
  const product = await productRepo.findById(productId);
  if (!product) return null;
  const images = await imageRepo.findByProduct(productId).catch(() => []);
  return { ...toProductDTO(product), images };
}

module.exports = { listByEnterprise, listCategoriesWithProducts, findById };
