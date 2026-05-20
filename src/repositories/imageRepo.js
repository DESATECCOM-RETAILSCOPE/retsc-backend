const repo = require('./jsonRepo');

const TABLE = 'images';
const PK = 'Image_id';

const findById = (id) => repo.readById(TABLE, id, PK);

const findByHash = (hash, enterpriseId) =>
  repo.findOne(TABLE, r => r.Hash === hash && r.Enterprise_id === enterpriseId);

const findByProduct = (productId) =>
  repo.findMany(TABLE, r => r.Product_id === productId);

const insert = (image) => repo.insert(TABLE, image, PK);

const insertMany = async (images) => {
  const inserted = [];
  for (const img of images) {
    inserted.push(await repo.insert(TABLE, img, PK));
  }
  return inserted;
};

module.exports = { findById, findByHash, findByProduct, insert, insertMany };
