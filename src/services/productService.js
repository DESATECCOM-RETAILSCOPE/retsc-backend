const productRepo = require('../repositories/productRepo');
const imageRepo   = require('../repositories/imageRepo');

async function listByEnterprise(enterpriseId, filters = {}) {
  const { categoryId, search, page = 1, limit = 50 } = filters;

  const all = await productRepo.listByEnterprise(enterpriseId, {
    categoryId: categoryId ? Number(categoryId) : undefined,
    search,
  });

  const total  = all.length;
  const start  = (page - 1) * limit;
  const paged  = all.slice(start, start + limit);

  const enriched = await Promise.all(
    paged.map(async (p) => {
      const images = await imageRepo.findByProduct(p.Product_id);
      return { ...p, primaryImage: images[0]?.Blob_url ?? null, imageCount: images.length };
    })
  );

  return { products: enriched, total, page: Number(page), limit: Number(limit) };
}

async function findById(productId, enterpriseId) {
  const product = await productRepo.findById(productId);
  if (!product) return null;
  if (product.Enterprise_id !== enterpriseId) return null; // seguridad cross-empresa
  const images = await imageRepo.findByProduct(productId);
  return { ...product, images };
}

module.exports = { listByEnterprise, findById };
