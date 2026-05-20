const repo = require('./jsonRepo');

const TABLE = 'roles';
const PK = 'Role_id';

const findById = (id) => repo.readById(TABLE, id, PK);

const findByName = (name) =>
  repo.findOne(TABLE, r => r.Role_name.toLowerCase() === name.toLowerCase());

const listAll = () => repo.readAll(TABLE);

module.exports = { findById, findByName, listAll };
