const productRepo = require('../repositories/productRepo');
const imageRepo   = require('../repositories/imageRepo');

function toProductDTO(row) {
  return {
    productId:    row.product_id,
    skuId:        row.SKU_ID,
    gtin:         row.EAN,
    description:  row.Product_dsc,
    categoryName: row.commercial_category_dsc ?? null,
    status:       row.status,
    primaryImage: row.image_url ?? null,
  };
}

async function listByEnterprise(enterpriseId, filters = {}) {
  const { categoryId, search, page = 1, limit = 50 } = filters;

  const all = await productRepo.listByEnterprise(enterpriseId, {
    categoryId: categoryId ? Number(categoryId) : undefined,
    search,
  });

  const total = all.length;
  const start = (page - 1) * limit;
  const paged = all.slice(start, start + limit);

  const products = paged.map(toProductDTO);

  return { products, total, page: Number(page), limit: Number(limit) };
}

async function findById(productId, enterpriseId) {
  const product = await productRepo.findById(productId);
  if (!product) return null;
  const images = await imageRepo.findByProduct(productId).catch(() => []);
  return { ...toProductDTO(product), images };
}

module.exports = { listByEnterprise, findById };
