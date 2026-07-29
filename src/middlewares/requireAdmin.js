// Wrapper legacy sobre requireRole — se mantiene como archivo separado para no
// tener que tocar todas las rutas que ya lo importan de golpe. ADMIN_DTC
// (superusuario, ve todo) siempre debe poder pasar donde pasa un ADMIN.
const requireRole = require('./requireRole');
const { ROLES } = require('../config/roles');

module.exports = requireRole(ROLES.ADMIN, ROLES.ADMIN_DTC);
