const repo = require('./jsonRepo');

const TABLE = 'cats';
const PK = 'Category_id';

const findById = (id) => repo.readById(TABLE, id, PK);

const listActive = () => repo.findMany(TABLE, r => r.Status === 1);

module.exports = { findById, listActive };
