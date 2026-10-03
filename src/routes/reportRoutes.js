// Prefijo en app.js: /api/reports — montado SIN authMiddleware a propósito: este PDF se abre
// desde el navegador del sistema (Linking.openURL en el mobile), que no manda el header
// Authorization. En su lugar, getCompliancePdf valida un token de corta duración (5 min) por
// query string (ver reportTokenService.js) — el endpoint que SÍ requiere sesión normal para
// emitir ese token (getReportToken) vive en sessionsRoutes.js, detrás de authMiddleware.

const express = require('express');
const router  = express.Router();
const c       = require('../controllers/reportController');

/**
 * @swagger
 * /api/reports/compliance.pdf:
 *   get:
 *     summary: PDF del reporte de cumplimiento de surtido
 *     tags: [Reports]
 *     description: >-
 *       Sin autenticación Bearer — requiere un token de corta duración obtenido vía
 *       GET /api/sessions/{id}/compliance/{categoryId}/report-token (ese sí autenticado).
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: PDF del reporte
 *         content:
 *           application/pdf: {}
 *       401:
 *         description: Token faltante, inválido o expirado
 */
router.get('/compliance.pdf', c.getCompliancePdf);

module.exports = router;
