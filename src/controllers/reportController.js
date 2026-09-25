// Controller del PDF de "Cumplimiento de Surtido". getReportToken vive detrás de
// authMiddleware (montado en /api/sessions, igual que sessionsController); getCompliancePdf
// vive en /api/reports SIN authMiddleware — se abre desde el navegador del sistema
// (Linking.openURL en el mobile, que no manda el header Authorization) y en cambio valida un
// token de corta duración por query string (ver reportTokenService.js).

const visitService                = require('../services/visitService');
const assortmentComplianceService  = require('../services/assortmentComplianceService');
const reportTokenService           = require('../services/reportTokenService');
const { buildComplianceReportDoc } = require('../services/complianceReportService');
const retailerRepo                 = require('../repositories/retailerRepo');
const categoryRepo                 = require('../repositories/categoryRepo');
const { ROLES, normalizeRole }     = require('../config/roles');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[report]', err);
  return res.status(status).json({ success: false, message: err.message });
}

function parseId(value, label) {
  const id = parseInt(value, 10);
  if (isNaN(id)) throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  return id;
}

// GET /api/sessions/:id/compliance/:categoryId/report-token
const getReportToken = async (req, res) => {
  try {
    const visitId    = parseId(req.params.id, 'Visit ID (session_id)');
    const categoryId = parseId(req.params.categoryId, 'Category ID');

    const visit = await visitService.getVisit(visitId);
    const isAdminDtc = normalizeRole(req.user.roleName) === ROLES.ADMIN_DTC;
    if (!isAdminDtc && visit.enterpriseId !== req.user.enterpriseId) {
      return res.status(403).json({ success: false, message: 'No puedes generar el reporte de una visita de otro enterprise.' });
    }

    const token = reportTokenService.mintReportToken({ visitId, categoryId, enterpriseId: visit.enterpriseId });
    return res.json({ success: true, token, expiresIn: process.env.REPORT_TOKEN_EXPIRES_IN || '5m' });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/reports/compliance.pdf?token=...
const getCompliancePdf = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) throw Object.assign(new Error('Token requerido.'), { statusCode: 401 });

    let claims;
    try {
      claims = reportTokenService.verifyReportToken(token);
    } catch (err) {
      throw Object.assign(new Error('Token de reporte inválido o expirado.'), { statusCode: 401 });
    }
    const { visitId, categoryId } = claims;

    const [result, retailer, category] = await Promise.all([
      assortmentComplianceService.getCompliance(visitId, categoryId),
      visitService.getVisit(visitId).then((v) => retailerRepo.findById(v.retailerId)),
      categoryRepo.findById(categoryId),
    ]);

    const doc = buildComplianceReportDoc({
      compliance:   result.compliance,
      share:        result.share,
      faltantes:    result.faltantes,
      enExceso:     result.enExceso,
      retailerName: retailer?.Retailer_dsc || 'PDV',
      categoryDsc:  category?.Category_dsc || 'Categoría',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cumplimiento-surtido-${visitId}-${categoryId}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { getReportToken, getCompliancePdf };
