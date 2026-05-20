const repo = require('./jsonRepo');

const TABLE = 'products';
const PK = 'Product_id';

const findById = (id) => repo.readById(TABLE, id, PK);

const findByGtinAndEnterprise = (gtin, enterpriseId) =>
  repo.findOne(TABLE, r => r.GTIN === gtin && r.Enterprise_id === enterpriseId);

const listByEnterprise = async (enterpriseId, filters = {}) => {
  return repo.findMany(TABLE, r => {
    if (r.Enterprise_id !== enterpriseId) return false;
    if (filters.categoryId != null && r.Category_id !== filters.categoryId) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const matchGtin = r.GTIN && r.GTIN.toLowerCase().includes(q);
      const matchDesc = r.Description && r.Description.toLowerCase().includes(q);
      if (!matchGtin && !matchDesc) return false;
    }
    return true;
  });
};

const insert = (product) => repo.insert(TABLE, product, PK);

const insertMany = async (products) => {
  const inserted = [];
  for (const p of products) {
    inserted.push(await repo.insert(TABLE, p, PK));
  }
  return inserted;
};

const update = (id, partial) => repo.update(TABLE, id, partial, PK);

module.exports = { findById, findByGtinAndEnterprise, listByEnterprise, insert, insertMany, update };
