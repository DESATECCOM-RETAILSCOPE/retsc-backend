const requireAdmin = (req, res, next) => {
  if (req.user?.roleName !== 'Admin') {
    return res.status(403).json({
      success: false,
      message: 'Esta acción requiere rol de administrador.',
    });
  }
  next();
};

module.exports = requireAdmin;
