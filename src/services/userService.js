const bcrypt = require('bcryptjs');
const userRepo           = require('../repositories/userRepo');
const userEnterpriseRepo = require('../repositories/userEnterpriseRepo');
const roleRepo           = require('../repositories/roleRepo');
const { isValidEmail, normalizeCedula, isValidCedulaFisica } = require('../utils/validators');

function svcError(msg, statusCode, payload) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  if (payload !== undefined) err.payload = payload;
  return err;
}

// ── 1.1 ──────────────────────────────────────────────────────────────────────
const listByEnterprise = async (enterpriseId) => {
  const relations = await userEnterpriseRepo.findByEnterprise(enterpriseId);

  const enriched = await Promise.all(
    relations.map(async (r) => {
      const user = await userRepo.findById(r.User_id);
      const role = await roleRepo.findById(r.Role_id);
      return {
        userId:            user?.User_id ?? r.User_id,
        userName:          user?.User_name ?? null,
        email:             user?.Email ?? null,
        cedIdentidad:      user?.ced_identidad ?? null,
        roleId:            role?.Role_id ?? r.Role_id,
        roleName:          role?.Role_name ?? null,
        status:            (r.Status === 1 || r.Status === true) ? 1 : 0,
        fechaActivacion:   r.Fecha_activacion,
        fechaInactivacion: r.Fecha_inactivacion,
      };
    })
  );

  return enriched;
};

// ── 1.3 ──────────────────────────────────────────────────────────────────────
// Decisión de negocio (feedback dueña, 1 Jul): una cédula duplicada con
// relación activa en OTRA empresa no debe revelar nada del usuario ni ofrecer
// asignación directa — es fuga de datos entre empresas. El traslado lo
// gestiona el call center de DTC inactivando la relación vieja; recién
// entonces esta empresa puede proceder. Si la cédula existe pero ya NO tiene
// relaciones activas (el call center ya la liberó), se reactiva el usuario
// con los datos del formulario y se lo vincula a esta empresa — mismo patrón
// que enterpriseService.createEnterprise() usa para su admin.
const createAndAssign = async (payload, enterpriseId) => {
  const { cedIdentidad, userName, email, telephone, password, roleId } = payload;

  const required = { cedIdentidad, userName, email, password, roleId };
  const missing = Object.entries(required).filter(([, v]) => v == null || v === '').map(([k]) => k);
  if (missing.length) throw svcError(`Campos requeridos faltantes: ${missing.join(', ')}`, 400);

  if (password.length < 8) throw svcError('La contraseña debe tener al menos 8 caracteres', 400);
  if (!isValidEmail(email)) throw svcError('Formato de email inválido', 400);
  if (!isValidCedulaFisica(cedIdentidad)) {
    throw svcError('La cédula física debe tener 9 dígitos (formato Costa Rica).', 400);
  }

  // Normalizada a solo dígitos — así el chequeo de duplicados no falla porque
  // una vez se tipeó con guiones y otra sin ellos.
  const normalizedCedula = normalizeCedula(cedIdentidad);
  const existingByCedula = await userRepo.findByCedula(normalizedCedula);

  let reactivating = false;
  if (existingByCedula) {
    const activeRelations = await userEnterpriseRepo.findActiveByUserId(existingByCedula.User_id);
    if (activeRelations.length > 0) {
      // Mismo mensaje exista o no relación activa "visible" para quien pregunta
      // — no hay rama que distinga el caso, así que no hay enumeración posible.
      throw svcError(
        'La cédula ya está registrada en el sistema. Comuníquese con el call center de DTC para gestionar el traslado.',
        409,
        { code: 'CEDULA_EXISTS' },
      );
    }
    reactivating = true;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingByEmail = await userRepo.findByEmail(normalizedEmail);
  if (existingByEmail && (!existingByCedula || existingByEmail.User_id !== existingByCedula.User_id)) {
    throw svcError('El email ya está registrado en el sistema.', 409);
  }

  const role = await roleRepo.findById(Number(roleId));
  if (!role) throw svcError(`El rol con id ${roleId} no existe.`, 400);

  const passwordHash = await bcrypt.hash(password, 10);

  let user;
  let insertedUserId = null;
  if (reactivating) {
    const updated = await userRepo.update(existingByCedula.User_id, {
      User_name:    userName.trim(),
      Email:        normalizedEmail,
      PasswordHash: passwordHash,
      Status:       1,
    });
    user = updated || existingByCedula;
  } else {
    user = await userRepo.insert({
      User_name:     userName.trim(),
      Email:         normalizedEmail,
      PasswordHash:  passwordHash,
      ced_identidad: normalizedCedula,
      Status:        1,
      Created_date:  new Date().toISOString(),
    });
    insertedUserId = user.User_id;
  }

  try {
    await userEnterpriseRepo.insert({
      User_id:            user.User_id,
      Enterprise_id:      enterpriseId,
      Role_id:            role.Role_id,
      Status:             1,
      Fecha_activacion:   new Date().toISOString(),
      Fecha_inactivacion: null,
    });
  } catch (err) {
    // Solo se revierte el usuario si lo creamos nosotros en este mismo request
    // — un usuario reactivado ya existía antes, no es nuestro para borrar.
    if (insertedUserId) await userRepo.remove(insertedUserId).catch(() => {});
    throw err;
  }

  return {
    userId: user.User_id,
    enterpriseId,
    roleId: role.Role_id,
    reactivated: reactivating,
    email: normalizedEmail,
    userName: userName.trim(),
  };
};

// ── 1.5 ──────────────────────────────────────────────────────────────────────
const updateUser = async (userId, payload, enterpriseId) => {
  // Verificar relación activa
  const activeRelations = await userEnterpriseRepo.findActiveByUserId(userId);
  const hasAccess = activeRelations.some(r => r.Enterprise_id === enterpriseId);
  if (!hasAccess) throw svcError('No tiene permiso para modificar este usuario.', 403);

  const { userName, email, password } = payload;
  const partial = {};

  if (userName != null) partial.User_name = userName.trim();

  if (email != null) {
    const normalized = email.trim().toLowerCase();
    if (!isValidEmail(normalized)) throw svcError('Formato de email inválido', 400);
    const taken = await userRepo.findByEmail(normalized);
    if (taken && taken.User_id !== userId) throw svcError('El email ya está en uso por otro usuario.', 409);
    partial.Email = normalized;
  }

  if (password != null) {
    if (password.length < 8) throw svcError('La contraseña debe tener al menos 8 caracteres', 400);
    partial.PasswordHash = await bcrypt.hash(password, 10);
  }

  const updated = await userRepo.update(userId, partial);
  if (!updated) throw svcError('Usuario no encontrado', 404);

  const { PasswordHash, ...safe } = updated;
  return safe;
};

// ── 1.6 ──────────────────────────────────────────────────────────────────────
const updateUserEnterprise = async (userId, enterpriseId, payload) => {
  const relation = await userEnterpriseRepo.findByUserAndEnterprise(userId, enterpriseId);
  if (!relation) throw svcError('Relación usuario-empresa no encontrada', 404);

  const { roleId, status, fechaInactivacion } = payload;
  const partial = {};

  if (roleId != null) {
    const role = await roleRepo.findById(Number(roleId));
    if (!role) throw svcError(`El rol con id ${roleId} no existe.`, 400);
    partial.Role_id = role.Role_id;
  }
  if (status != null)            partial.Status             = status;
  if (fechaInactivacion != null) partial.Fecha_inactivacion = fechaInactivacion;

  const updated = await userEnterpriseRepo.update(userId, enterpriseId, partial);
  return updated;
};

module.exports = {
  listByEnterprise,
  createAndAssign,
  updateUser,
  updateUserEnterprise,
};
