// Dashboard web (Parte B): GET /api/dashboard/opciones
// Opciones de los filtros de categoría, cadena y formato para la empresa resuelta
// por rol (ADMIN_DTC la elige con enterpriseId; un cliente ve la suya y recibe 403
// si pide otra). La lista de empresas para DTC sale de GET /api/enterprises.

const repo = require('../repositories/dashboardOpcionesRepo');
const { resolveEnterpriseId } = require('../utils/dashboardFilters');

async function opciones(req, res) {
  try {
    const enterpriseId = resolveEnterpriseId(req.user, req.query?.enterpriseId);
    const data = await repo.opciones(enterpriseId);
    return res.json({ success: true, enterpriseId, data });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error('[dashboard/opciones]', err);
    return res.status(status).json({
      success: false,
      message: status === 500 ? 'Error al obtener las opciones de los filtros.' : err.message,
    });
  }
}

module.exports = { opciones };
