const roleService = require('../services/roleService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[roles]', err);
  return res.status(status).json({ success: false, message: err.message });
}

// GET /api/roles
const listRoles = async (req, res) => {
  try {
    const roles = await roleService.listAll();
    return res.json({ success: true, roles });
  } catch (err) { return handleError(res, err); }
};

// GET /api/roles/:id
const getRole = async (req, res) => {
  try {
    const role = await roleService.getById(Number(req.params.id));
    return res.json({ success: true, role });
  } catch (err) { return handleError(res, err); }
};

// POST /api/roles
const createRole = async (req, res) => {
  try {
    const role = await roleService.create(req.body);
    return res.status(201).json({ success: true, role });
  } catch (err) { return handleError(res, err); }
};

// PUT /api/roles/:id
const updateRole = async (req, res) => {
  try {
    const role = await roleService.update(Number(req.params.id), req.body);
    return res.json({ success: true, role });
  } catch (err) { return handleError(res, err); }
};

// PATCH /api/roles/:id/status
const setStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (status !== 0 && status !== 1) {
      return res.status(400).json({ success: false, message: 'status debe ser 0 (inactivo) o 1 (activo)' });
    }
    const role = await roleService.setStatus(Number(req.params.id), status);
    return res.json({ success: true, role });
  } catch (err) { return handleError(res, err); }
};

module.exports = { listRoles, getRole, createRole, updateRole, setStatus };
