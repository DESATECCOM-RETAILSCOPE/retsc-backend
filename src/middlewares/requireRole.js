// Middleware de autorización por rol. Generaliza requireAdmin para aceptar uno o
// varios roles permitidos.
//
// Uso:
//   const requireRole = require('../middlewares/requireRole');
//   const { ROLES } = require('../config/roles');
//   router.patch('/:id/approve', authMiddleware, requireRole(ROLES.ADMIN, ROLES.ADMIN_DTC), ctrl.approve);
//
// Requiere que authMiddleware haya corrido antes (lee req.user.roleName, que arma
// authService al firmar el JWT).
//
// La comparación se normaliza (trim + mayúsculas) en ambos lados vía
// normalizeRole — antes era exacta y case-sensitive, lo cual rompió la
// autorización completa cuando los roles se renombraron a mayúsculas
// (scripts/sync-roles-with-qa.js) sin actualizar estos middlewares.

const { normalizeRole } = require('../config/roles');

function requireRole(...allowedRoles) {
  const normalizedAllowed = allowedRoles.map(normalizeRole);
  return (req, res, next) => {
    const role = normalizeRole(req.user?.roleName);
    if (!role || !normalizedAllowed.includes(role)) {
      return res.status(403).json({
        success: false,
        message: `Esta acción requiere uno de los roles: ${allowedRoles.join(', ')}.`,
      });
    }
    next();
  };
}

module.exports = requireRole;
