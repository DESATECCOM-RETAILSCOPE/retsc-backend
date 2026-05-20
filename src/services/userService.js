const bcrypt = require('bcryptjs');
const userRepo           = require('../repositories/userRepo');
const userEnterpriseRepo = require('../repositories/userEnterpriseRepo');
const roleRepo           = require('../repositories/roleRepo');

function svcError(msg, statusCode) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  return err;
}

// ── 1.1 ──────────────────────────────────────────────────────────────────────
const listByEnterprise = async (enterpriseId) => {
  const relations = await userEnterpriseRepo.findByEnterprise(enterpriseId);
  // Solo relaciones activas
  const active = relations.filter(r => r.Status === 1);

  const enriched = await Promise.all(
    active.map(async (r) => {
      const user = await userRepo.findById(r.User_id);
      const role = await roleRepo.findById(r.Role_id);
      return {
        userId:            user?.User_id ?? r.User_id,
        userName:          user?.User_name ?? null,
        email:             user?.Email ?? null,
        cedIdentidad:      user?.ced_identidad ?? null,
        roleId:            role?.Role_id ?? r.Role_id,
        roleName:          role?.Role_name ?? null,
        status:            r.Status,
        fechaActivacion:   r.Fecha_activacion,
        fechaInactivacion: r.Fecha_inactivacion,
      };
    })
  );

  return enriched;
};

// ── 1.2 ──────────────────────────────────────────────────────────────────────
const findByCedula = async (ced) => {
  const user = await userRepo.findByCedula(ced);
  if (!user) return { exists: false };
  return {
    exists: true,
    user: {
      userId:      user.User_id,
      userName:    user.User_name,
      email:       user.Email,
      cedIdentidad: user.ced_identidad,
    },
  };
};

// ── 1.3 ──────────────────────────────────────────────────────────────────────
const createAndAssign = async (payload, enterpriseId) => {
  const { cedIdentidad, userName, email, telephone, password, roleId } = payload;

  const required = { cedIdentidad, userName, email, password, roleId };
  const missing = Object.entries(required).filter(([, v]) => v == null || v === '').map(([k]) => k);
  if (missing.length) throw svcError(`Campos requeridos faltantes: ${missing.join(', ')}`, 400);

  if (password.length < 8) throw svcError('La contraseña debe tener al menos 8 caracteres', 400);

  if (await userRepo.findByCedula(cedIdentidad)) {
    throw svcError('La cédula ya existe. Use POST /api/users/assign para asignar el usuario existente.', 409);
  }

  if (await userRepo.findByEmail(email.trim().toLowerCase())) {
    throw svcError('El email ya está registrado en el sistema.', 409);
  }

  const role = await roleRepo.findById(Number(roleId));
  if (!role) throw svcError(`El rol con id ${roleId} no existe.`, 400);

  const passwordHash = await bcrypt.hash(password, 10);
  const inserted = await userRepo.insert({
    User_name:     userName.trim(),
    Email:         email.trim().toLowerCase(),
    PasswordHash:  passwordHash,
    ced_identidad: cedIdentidad.trim(),
    Status:        1,
    Created_date:  new Date().toISOString(),
  });

  try {
    await userEnterpriseRepo.insert({
      User_id:            inserted.User_id,
      Enterprise_id:      enterpriseId,
      Role_id:            role.Role_id,
      Status:             1,
      Fecha_activacion:   new Date().toISOString(),
      Fecha_inactivacion: null,
    });
  } catch (err) {
    await userRepo.remove(inserted.User_id).catch(() => {});
    throw err;
  }

  return { userId: inserted.User_id, enterpriseId, roleId: role.Role_id };
};

// ── 1.4 ──────────────────────────────────────────────────────────────────────
const assignToEnterprise = async (userId, roleId, enterpriseId) => {
  if (!userId || !roleId) throw svcError('userId y roleId son requeridos', 400);

  if (!await userRepo.findById(userId)) throw svcError('Usuario no encontrado', 404);

  const role = await roleRepo.findById(Number(roleId));
  if (!role) throw svcError(`El rol con id ${roleId} no existe.`, 400);

  const existing = await userEnterpriseRepo.findByUserAndEnterprise(userId, enterpriseId);

  if (existing) {
    if (existing.Status === 1) {
      throw svcError('El usuario ya está asignado a esta empresa.', 409);
    }
    // Relación inactiva — reactivar
    await userEnterpriseRepo.update(existing.Id, {
      Role_id:            role.Role_id,
      Status:             1,
      Fecha_activacion:   new Date().toISOString(),
      Fecha_inactivacion: null,
    });
    return { userId, enterpriseId, roleId: role.Role_id, action: 'reactivated' };
  }

  await userEnterpriseRepo.insert({
    User_id:            userId,
    Enterprise_id:      enterpriseId,
    Role_id:            role.Role_id,
    Status:             1,
    Fecha_activacion:   new Date().toISOString(),
    Fecha_inactivacion: null,
  });
  return { userId, enterpriseId, roleId: role.Role_id, action: 'created' };
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

  const updated = await userEnterpriseRepo.update(relation.Id, partial);
  return updated;
};

module.exports = {
  listByEnterprise,
  findByCedula,
  createAndAssign,
  assignToEnterprise,
  updateUser,
  updateUserEnterprise,
};
