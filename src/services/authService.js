const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const userRepo           = require('../repositories/userRepo');
const userEnterpriseRepo = require('../repositories/userEnterpriseRepo');
const roleRepo           = require('../repositories/roleRepo');
const enterpriseRepo     = require('../repositories/enterpriseRepo');
const { isValidEmail }   = require('../utils/validators');
const { sendMail }       = require('../utils/mailer');

// ────────────── Helpers ──────────────

function serviceError(msg, statusCode) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  return err;
}

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    // Default 30m (Issue B6/QA) — antes 1h. authMiddleware ya responde 401
    // { code: 'TOKEN_EXPIRED' } al vencer, y el frontend redirige a login con eso.
    expiresIn: process.env.JWT_EXPIRES_IN || '30m',
  });
}

function signRefreshToken(payload) {
  // El refresh solo lleva lo mínimo para identificar al usuario.
  // El access trae todo (rol, empresa, etc.).
  return jwt.sign(
    { userId: payload.userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );
}

function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    if (decoded.type !== 'refresh') {
      throw serviceError('Token inválido', 401);
    }
    return decoded;
  } catch (err) {
    if (err.statusCode) throw err;
    if (err.name === 'TokenExpiredError') {
      throw serviceError('Refresh token expirado, inicie sesión nuevamente', 401);
    }
    throw serviceError('Refresh token inválido', 401);
  }
}

// ────────────── Funciones existentes (intactas) ──────────────

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
  if (!isValidEmail(email)) throw serviceError('Formato de email inválido', 400);
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

// ────────────── Login: resolver datos + emitir par de tokens ──────────────

const resolveLoginData = async (email, password) => {
  const user = await userRepo.findByEmail(email);
  if (!user) {
    throw serviceError('Credenciales inválidas', 401);
  }

  // Validar password ANTES de revelar si el usuario existe o no
  // (evita user enumeration: misma respuesta para "no existe" y "password mal")
  const isValid = await bcrypt.compare(password, user.PasswordHash);
  if (!isValid) {
    throw serviceError('Credenciales inválidas', 401);
  }

// Validar usuario activo (Status = 1 / true)
  // Nota: mssql mapea columnas BIT a boolean, por eso aceptamos true o 1.
  if (user.Status !== 1 && user.Status !== true) {
    throw serviceError('Usuario inactivo. Contacte al administrador.', 403);
  }

  // Validar que tenga al menos una relación activa con una empresa
  const relations = await userEnterpriseRepo.findActiveByUserId(user.User_id);
  if (!relations.length) {
    throw serviceError(
      'El usuario no tiene empresas activas asignadas. Contacte al administrador.',
      403
    );
  }

  // Tomar la relación más antigua (menor Id) — comportamiento original
  const relation = relations.reduce((min, r) => r.Id < min.Id ? r : min, relations[0]);

  const role = await roleRepo.findById(relation.Role_id);
  if (!role) {
    throw serviceError('Rol del usuario no encontrado. Contacte al administrador.', 500);
  }

  const enterprise = await enterpriseRepo.findById(relation.Enterprise_id);

  return { user, relation, role, enterprise };
};

const issueTokens = (user, relation, role) => {
  const accessPayload = {
    userId:       user.User_id,
    email:        user.Email,
    username:     user.User_name,
    enterpriseId: relation.Enterprise_id,
    roleId:       role.Role_id,
    roleName:     role.Role_name,
  };

  return {
    accessToken:  signAccessToken(accessPayload),
    refreshToken: signRefreshToken({ userId: user.User_id }),
  };
};

// ────────────── Refresh: validar y emitir access nuevo ──────────────

const refreshAccessToken = async (refreshToken) => {
  if (!refreshToken) {
    throw serviceError('Refresh token requerido', 400);
  }

  const decoded = verifyRefreshToken(refreshToken);

  // Re-leer el usuario actual desde la BD (puede haberse desactivado entre tanto)
  const user = await userRepo.findById(decoded.userId);
  if (!user) {
    throw serviceError('Usuario no encontrado', 401);
  }

if (user.Status !== 1 && user.Status !== true) {
    throw serviceError('Usuario inactivo. Contacte al administrador.', 403);
  }

  const relations = await userEnterpriseRepo.findActiveByUserId(user.User_id);
  if (!relations.length) {
    throw serviceError(
      'El usuario no tiene empresas activas asignadas. Contacte al administrador.',
      403
    );
  }

  const relation = relations.reduce((min, r) => r.Id < min.Id ? r : min, relations[0]);

  const role = await roleRepo.findById(relation.Role_id);
  if (!role) {
    throw serviceError('Rol del usuario no encontrado. Contacte al administrador.', 500);
  }

  const accessToken = signAccessToken({
    userId:       user.User_id,
    email:        user.Email,
    username:     user.User_name,
    enterpriseId: relation.Enterprise_id,
    roleId:       role.Role_id,
    roleName:     role.Role_name,
  });

  return { accessToken };
};

// ────────────── Forgot password ──────────────

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let pwd = '';
  for (let i = 0; i < 10; i++) pwd += chars[bytes[i] % chars.length];
  return pwd;
}

const forgotPassword = async (identifier) => {
  // Busca por email o username — misma respuesta genérica si no existe (evita enumeración)
  const GENERIC_MSG = 'Si el usuario existe, recibirá una nueva contraseña por correo.';

  let user = null;
  if (isValidEmail(identifier)) {
    user = await userRepo.findByEmail(identifier.trim().toLowerCase());
  } else {
    const all = await userRepo.listAll();
    user = all.find(u => u.User_name === identifier.trim()) ?? null;
  }

  if (!user) return { message: GENERIC_MSG };

  if (user.Status !== 1 && user.Status !== true) return { message: GENERIC_MSG };

  const newPassword = generatePassword();
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await userRepo.update(user.User_id, { PasswordHash: passwordHash });

  await sendMail({
    to:      user.Email,
    subject: 'Tu nueva contraseña — RetailScope',
    text:    `Hola ${user.User_name},\n\nTu nueva contraseña es: ${newPassword}\n\nTe recomendamos cambiarla después de iniciar sesión.\n\nEquipo RetailScope`,
    html:    `<p>Hola <strong>${user.User_name}</strong>,</p>
              <p>Tu nueva contraseña es: <strong>${newPassword}</strong></p>
              <p>Te recomendamos cambiarla después de iniciar sesión.</p>
              <p>Equipo RetailScope</p>`,
  });

  return { message: GENERIC_MSG };
};

module.exports = {
  findUserByEmail,
  findUserByUsername,
  findUserById,
  getAllUsers,
  createUser,
  validatePassword,
  resolveLoginData,
  issueTokens,
  refreshAccessToken,
  forgotPassword,
};