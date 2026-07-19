const userService = require('../services/userService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[user]', err);
  // err.payload (ej. code + user, ver createAndAssign / cédula duplicada) viaja
  // adjunto a la respuesta sin romper el contrato { success, message } existente.
  return res.status(status).json({ success: false, message: err.message, ...(err.payload ?? {}) });
}

// GET /api/users
const listUsers = async (req, res) => {
  try {
    const users = await userService.listByEnterprise(req.user.enterpriseId);
    return res.json({ success: true, users });
  } catch (err) { return handleError(res, err); }
};

// POST /api/users
// createAndAssign maneja tanto el alta de un usuario nuevo como el caso de una
// cédula ya existente sin relaciones activas (reactivación silenciosa) — ver
// userService.js para el detalle de ambas ramas.
const createUser = async (req, res) => {
  try {
    const result = await userService.createAndAssign(req.body, req.user.enterpriseId);
    const message = result.reactivated
      ? 'Usuario reactivado y asignado a la empresa.'
      : 'Usuario creado y asignado a la empresa.';
    return res.status(201).json({ success: true, userId: result.userId, message });
  } catch (err) { return handleError(res, err); }
};

// PUT /api/users/:id
const updateUser = async (req, res) => {
  try {
    const user = await userService.updateUser(Number(req.params.id), req.body, req.user.enterpriseId);
    return res.json({ success: true, user });
  } catch (err) { return handleError(res, err); }
};

// PUT /api/users/:userId/enterprises/:enterpriseId
const updateUserEnterprise = async (req, res) => {
  try {
    const urlEnterpriseId = Number(req.params.enterpriseId);
    if (urlEnterpriseId !== req.user.enterpriseId) {
      return res.status(403).json({ success: false, message: 'No tiene permiso para modificar relaciones de otra empresa.' });
    }
    const relation = await userService.updateUserEnterprise(
      Number(req.params.userId),
      urlEnterpriseId,
      req.body
    );
    return res.json({ success: true, relation });
  } catch (err) { return handleError(res, err); }
};

module.exports = { listUsers, createUser, updateUser, updateUserEnterprise };
