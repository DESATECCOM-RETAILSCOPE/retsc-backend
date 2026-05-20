const repo = require('./jsonRepo');

const TABLE = 'load_states';
const PK = 'Job_id';

const findById = (jobId) => repo.readById(TABLE, jobId, PK);

// Caller must supply Job_id (UUID) — we validate it's present
const insert = (loadState) => {
  if (!loadState[PK]) throw new Error('loadState must include a Job_id (UUID)');
  return repo.insert(TABLE, loadState, PK);
};

const update = (jobId, partial) => repo.update(TABLE, jobId, partial, PK);

const listByEnterprise = (enterpriseId) =>
  repo.findMany(TABLE, r => r.Enterprise_id === enterpriseId);

module.exports = { findById, insert, update, listByEnterprise };
