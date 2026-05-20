const repo = require('./jsonRepo');

const TABLE = 'usrsxenterp';
const PK = 'Id';

const findActiveByUserId = (userId, currentDate) => {
  const now = currentDate ? new Date(currentDate) : new Date();
  return repo.findMany(TABLE, r => {
    if (r.User_id !== userId || r.Status !== 1) return false;
    const activation = new Date(r.Fecha_activacion);
    if (now < activation) return false;
    if (r.Fecha_inactivacion != null && now > new Date(r.Fecha_inactivacion)) return false;
    return true;
  });
};

const findByEnterprise = (enterpriseId) =>
  repo.findMany(TABLE, r => r.Enterprise_id === enterpriseId);

const findByUserAndEnterprise = (userId, enterpriseId) =>
  repo.findOne(TABLE, r => r.User_id === userId && r.Enterprise_id === enterpriseId);

const insert = (relation) => repo.insert(TABLE, relation, PK);

const update = (id, partial) => repo.update(TABLE, id, partial, PK);

module.exports = { findActiveByUserId, findByEnterprise, findByUserAndEnterprise, insert, update };
