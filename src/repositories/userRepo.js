const repo = require('./jsonRepo');

const TABLE = 'users';
const PK = 'User_id';

const findById = (id) => repo.readById(TABLE, id, PK);

const findByEmail = (email) =>
  repo.findOne(TABLE, r => r.Email.toLowerCase() === email.toLowerCase());

const findByCedula = (ced) =>
  repo.findOne(TABLE, r => r.ced_identidad === ced);

const listAll = () => repo.readAll(TABLE);

const insert = (user) => repo.insert(TABLE, user, PK);

const update = (id, partial) => repo.update(TABLE, id, partial, PK);

module.exports = { findById, findByEmail, findByCedula, listAll, insert, update };
