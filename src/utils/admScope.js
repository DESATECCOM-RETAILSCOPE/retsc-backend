/**
 * admScope.js — Decide sobre QUÉ empresa opera una petición de /api/adm.
 *
 * Para qué sirve: aplica la regla central de la especificación: el enterpriseId de un
 *   usuario cliente sale SIEMPRE del token (JWT), nunca de la URL ni del cuerpo.
 *   Un usuario ADMIN_DTC, en cambio, elige la empresa en cada petición.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos:
 *   // TODO: unificar con dashboardFilters.resolveEnterpriseId cuando se decida un
 *   //       mecanismo único de "cambiar de empresa" para ADMIN_DTC (hoy cada módulo
 *   //       lo resuelve a su manera).
 *
 * NOTA: la especificación habla de una "sesión del servidor", pero este backend usa JWT
 *   sin estado y el token de un ADMIN_DTC trae siempre su empresa "de casa". Por eso el
 *   ADMIN_DTC manda la empresa en cada petición (?enterpriseId=), igual que el dashboard.
 */

const { ROLES, normalizeRole } = require('../config/roles');
const { svcError, fieldError, optionalPositiveInt } = require('./admValidation');

// ¿El usuario del token es ADMIN_DTC? Se compara con normalizeRole, nunca por Role_id
// (ese id cambia entre ambientes).
function isAdminDtc(user) {
  return normalizeRole(user?.roleName) === ROLES.ADMIN_DTC;
}

// Devuelve el Enterprise_id sobre el que se debe operar o lanza el error correspondiente.
//  - ADMIN_DTC: la empresa es obligatoria y se toma de lo que pida (422 si falta).
//  - Cliente: siempre la del token. Si pide otra distinta, 404 (no 403) para no
//    confirmar que ese recurso existe, como pide la especificación.
function resolveEnterpriseId(user, requestedRaw) {
  const requested = optionalPositiveInt(requestedRaw, 'enterpriseId', 'La empresa');

  if (isAdminDtc(user)) {
    if (requested == null) throw fieldError('enterpriseId', 'Seleccione una empresa.');
    return requested;
  }

  if (user?.enterpriseId == null) {
    throw svcError('El usuario no tiene una empresa asociada.', 403);
  }
  const own = Number(user.enterpriseId);
  if (requested != null && requested !== own) {
    throw svcError('Recurso no encontrado.', 404);
  }
  return own;
}

module.exports = { isAdminDtc, resolveEnterpriseId };
