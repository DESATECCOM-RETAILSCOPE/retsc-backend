const bcrypt = require('bcryptjs');
const userRepo           = require('../repositories/userRepo');
const userEnterpriseRepo = require('../repositories/userEnterpriseRepo');
const roleRepo           = require('../repositories/roleRepo');

const findUserByEmail = (email) => userRepo.findByEmail(email);

const findUserByUsername = async (username) => {
  const users = await userRepo.listAll();
  return users.find(u => u.User_name === username) ?? null;
};

const findUserById = async (userId) => {
  const user = await userRepo.findById(userId);
  if (!user) return null;
  const { PasswordHash, ...safe } = user;
  return safe;
};

const getAllUsers = async () => {
  const users = await userRepo.listAll();
  return users.map(({ PasswordHash, ...safe }) => safe);
};

const createUser = async ({ username, email, password, cedIdentidad }) => {
  const passwordHash = await bcrypt.hash(password, 10);
  const inserted = await userRepo.insert({
    User_name:     username,
    Email:         email,
    PasswordHash:  passwordHash,
    ced_identidad: cedIdentidad,
    Status:        1,
    Created_date:  new Date().toISOString(),
  });
  return inserted.User_id;
};

const validatePassword = (plain, hash) => bcrypt.compare(plain, hash);

const resolveLoginData = async (email, password) => {
  const user = await userRepo.findByEmail(email);
  if (!user) {
    const err = new Error('Credenciales inválidas'); err.statusCode = 401; throw err;
  }

  const isValid = await bcrypt.compare(password, user.PasswordHash);
  if (!isValid) {
    const err = new Error('Credenciales inválidas'); err.statusCode = 401; throw err;
  }

  const relations = await userEnterpriseRepo.findActiveByUserId(user.User_id);
  if (!relations.length) {
    const err = new Error('El usuario no tiene empresas activas asignadas. Contacte al administrador.');
    err.statusCode = 403; throw err;
  }

  const relation = relations.reduce((min, r) => r.Id < min.Id ? r : min, relations[0]);

  const role = await roleRepo.findById(relation.Role_id);
  if (!role) {
    const err = new Error('Rol del usuario no encontrado. Contacte al administrador.');
    err.statusCode = 500; throw err;
  }

  return { user, relation, role };
};

module.exports = {
  findUserByEmail,
  findUserByUsername,
  findUserById,
  getAllUsers,
  createUser,
  validatePassword,
  resolveLoginData,
};
