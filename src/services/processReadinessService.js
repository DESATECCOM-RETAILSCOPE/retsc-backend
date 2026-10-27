// Chequeo de "¿puede este usuario procesar fotos de esta categoría en este punto de venta
// ahora mismo?" — construido tras un crash real en producción (2026-10-23, Enterprise_id=2
// "DTC"): un usuario pudo tomar fotos y llegar hasta "Procesar" sin ningún aviso, y recién
// ahí el INSERT de RETSC_EX_ASSORTMENT_COMPLIANCE.cumplimiento_pct reventó con un error
// crudo de SQL ("Cannot insert the value NULL...") porque esa empresa nunca tuvo surtido
// cargado (RETSC_OP_ASSORTMENT sin filas) para ese retailer/formato/categoría — ver
// assortmentComplianceRepo.calculateAndSave, CTE `autorizados`.
//
// Centraliza en un solo lugar las condiciones "duras" que YA eran necesarias para que ese
// cálculo funcionara, para poder:
//   1. Bloquear la entrada al módulo de captura ANTES de que el usuario pierda tiempo
//      tomando fotos (GET /api/readiness — el mobile lo llama desde VisitCaptureScreen,
//      al tocar "Tomar Fotos...").
//   2. Servir de red de seguridad dentro de assortmentComplianceService.getCompliance(): si
//      el chequeo del mobile se bypassea por una caché vieja o una condición de carrera,
//      el backend nunca vuelve a producir un error crudo de SQL — devuelve un 409 con un
//      mensaje accionable en su lugar.
const retailerRepo = require('../repositories/retailerRepo');
const aiModelRepo = require('../repositories/aiModelRepo');
const assortmentComplianceRepo = require('../repositories/assortmentComplianceRepo');
const customVisionPredictService = require('./customVisionPredictService');

// Devuelve { ready, blockers: [{ code, message }] } — nunca lanza por sí mismo; un retailer
// inexistente o mal configurado es, para este chequeo, simplemente "bloqueado" con su propio
// código, no una excepción (a diferencia de visitService/assortmentComplianceService, que sí
// tiran 404 cuando el recurso no existe en el flujo normal de una visita ya abierta).
async function checkReadiness({ enterpriseId, retailerId, categoryId }) {
  const blockers = [];

  const retailer = await retailerRepo.findById(retailerId);
  if (!retailer) {
    blockers.push({ code: 'RETAILER_NOT_FOUND', message: 'El punto de venta no existe.' });
    return { ready: false, blockers };
  }
  if (retailer.Supermarketchain_id == null || !retailer.Formato) {
    // Sin cadena/formato no se puede evaluar surtido — no tiene sentido seguir acumulando
    // bloqueadores sobre datos que dependen de esto.
    blockers.push({
      code: 'RETAILER_MISSING_CHAIN_FORMAT',
      message: 'Este punto de venta no tiene cadena/formato configurado. Contactá al equipo de DTC.',
    });
    return { ready: false, blockers };
  }

  const modelo = await aiModelRepo.findByCategoryId(categoryId);
  try {
    customVisionPredictService.validarModelo(modelo, categoryId);
  } catch (err) {
    blockers.push({
      code: 'NO_DETECTION_MODEL',
      message: 'Esta categoría todavía no tiene un modelo de detección publicado. Contactá al equipo de DTC.',
    });
  }

  const hasAssortment = await assortmentComplianceRepo.hasActiveAssortment({
    enterpriseId,
    supermarketchainId: retailer.Supermarketchain_id,
    format: retailer.Formato,
    categoryId,
  });
  if (!hasAssortment) {
    blockers.push({
      code: 'NO_ASSORTMENT',
      message: 'Esta empresa no tiene surtido autorizado cargado para esta categoría en este tipo de tienda. Contactá al equipo de catálogo.',
    });
  }

  return { ready: blockers.length === 0, blockers };
}

module.exports = { checkReadiness };
