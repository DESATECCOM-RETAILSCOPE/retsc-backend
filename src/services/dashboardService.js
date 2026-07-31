// Servicio del dashboard (Issue B7). Resuelve el SCOPE (global vs. por empresa) según el
// rol del usuario logueado y delega el conteo real a dashboardRepo.js.

const dashboardRepo = require('../repositories/dashboardRepo');
const { ROLES, normalizeRole } = require('../config/roles');

// ADMIN_DTC ve la plataforma completa (enterpriseId=null → conteo global en el repo).
// ADMIN y GERENCIA quedan escopeados a su propia empresa (req.user.enterpriseId).
//
// NOTA sobre GERENCIA: el pedido original decía "Supervisor", pero ese rol está
// desactivado en el catálogo (0 usuarios, ver scripts/sync-roles-with-qa.js) — el rol de
// gerencia activo hoy es GERENCIA. Se asume que es el mismo concepto; CONFIRMAR con María.
// GERENCIA se trata igual que ADMIN acá (scope = su propia empresa) porque el JWT no
// distingue ningún otro scope posible para ese rol — no hay un concepto de "región" o
// "grupo de empresas" en el token hoy.
function resolveScope(user) {
  const isDtc = normalizeRole(user?.roleName) === ROLES.ADMIN_DTC;
  return { enterpriseId: isDtc ? null : user.enterpriseId };
}

async function getDashboard(user) {
  const scope = resolveScope(user);

  const [productCards, productPhotos, activeAssortments, analysesDone] = await Promise.all([
    dashboardRepo.countProductCards(scope),
    dashboardRepo.countProductPhotos(scope),
    dashboardRepo.countActiveAssortments(scope),
    dashboardRepo.countAnalysesDone(scope),
  ]);

  return { productCards, productPhotos, activeAssortments, analysesDone };
}

module.exports = { getDashboard };
