const repo = require('./jsonRepo');

const TABLE = 'enterprises';
const PK = 'Enterprise_id';

const findById = (id) => repo.readById(TABLE, id, PK);

const findByFiscalId = (fiscalId) =>
  repo.findOne(TABLE, r => r.Fiscal_id === fiscalId);

const listAll = () => repo.readAll(TABLE);

const insert = (enterprise) => repo.insert(TABLE, enterprise, PK);

const update = (id, partial) => repo.update(TABLE, id, partial, PK);

module.exports = { findById, findByFiscalId, listAll, insert, update };
