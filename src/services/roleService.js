const roleRepo = require('../repositories/roleRepo');

function svcError(msg, statusCode) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  return err;
}

function toDTO(row) {
  if (!row) return null;
  return {
    roleId:      row.Role_id,
    roleName:    row.Role_name,
    description: row.Description ?? null,
    status:      row.Status ? 1 : 0,  // mssql BIT → JS boolean; normalize to 1/0
  };
}

// GET /api/roles — contrato: { success, roles: [{ roleId, roleName, description, status }] }
// activeOnly=true filtra Status=1 (usado por el frontend en el dropdown de rol del alta de usuario).
const listAll = async (activeOnly = false) => {
  const rows = await roleRepo.listAll();
  const dtos = rows.map(toDTO);
  return activeOnly ? dtos.filter((r) => r.status === 1) : dtos;
};

const getById = async (id) => {
  const row = await roleRepo.findById(id);
  if (!row) throw svcError('Rol no encontrado', 404);
  return toDTO(row);
};

const create = async ({ roleName, description }) => {
  if (!roleName?.trim()) throw svcError('El nombre del rol es requerido', 400);

  const existing = await roleRepo.findByName(roleName.trim());
  if (existing) throw svcError('Ya existe un rol con ese nombre', 409);

  const row = await roleRepo.insert({
    Role_name:   roleName.trim(),
    Description: description?.trim() ?? null,
    Status:      1,
  });
  return toDTO(row);
};

const update = async (id, { roleName, description }) => {
  const row = await roleRepo.findById(id);
  if (!row) throw svcError('Rol no encontrado', 404);

  if (roleName != null) {
    const normalized = roleName.trim();
    const taken = await roleRepo.findByName(normalized);
    if (taken && taken.Role_id !== id) throw svcError('Ya existe un rol con ese nombre', 409);
  }

  const partial = {};
  if (roleName    != null) partial.Role_name   = roleName.trim();
  if (description != null) partial.Description = description.trim();

  if (Object.keys(partial).length === 0) return toDTO(row);

  const updated = await roleRepo.update(id, partial);
  return toDTO(updated ?? row);
};

const setStatus = async (id, status) => {
  const row = await roleRepo.findById(id);
  if (!row) throw svcError('Rol no encontrado', 404);

  const updated = await roleRepo.update(id, { Status: status });
  return toDTO(updated ?? row);
};

module.exports = { listAll, getById, create, update, setStatus };
