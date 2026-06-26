// Middleware de autorización por rol. Generaliza requireAdmin para aceptar uno o
// varios roles permitidos.
//
// Uso:
//   const requireRole = require('../middlewares/requireRole');
//   router.patch('/:id/approve', authMiddleware, requireRole('Admin', 'Supervisor'), ctrl.approve);
//
// Requiere que authMiddleware haya corrido antes (lee req.user.roleName, que arma
// authService al firmar el JWT).
//
// NOTA: la comparación es exacta y sensible a mayúsculas, igual que requireAdmin
// ('Admin'). Los nombres deben coincidir con Role_name en RETSC_OP_ROLES.

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const role = req.user?.roleName;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: `Esta acción requiere uno de los roles: ${allowedRoles.join(', ')}.`,
      });
    }
    next();
  };
}

module.exports = requireRole;
