const repo = require('./jsonRepo');

const TABLE = 'ai_models';
const PK = 'Model_id';

const findActiveByCategory = (categoryId) =>
  repo.findMany(TABLE, r => r.Category_id === categoryId && r.Status === 'active');

const listAll = () => repo.readAll(TABLE);

const insert = (model) => repo.insert(TABLE, model, PK);

const update = (id, partial) => repo.update(TABLE, id, partial, PK);

module.exports = { findActiveByCategory, listAll, insert, update };
