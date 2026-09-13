// Orquesta el reporte "Cumplimiento de Surtido" (María, 2026-09) para una visita/categoría:
// resuelve Supermarketchain_id/Format del retailer de la visita y supplier_name del
// enterprise (migración 011), calcula+persiste con assortmentComplianceRepo, y arma la
// respuesta para el mobile (ResultsScreen) con el desglose y el detalle de faltantes/exceso.
//
// Se calcula BAJO DEMANDA — cada llamada inserta una fila nueva en
// RETSC_EX_ASSORTMENT_COMPLIANCE (histórico), no hace upsert.

const visitRepo               = require('../repositories/visitRepo');
const retailerRepo            = require('../repositories/retailerRepo');
const enterpriseRepo          = require('../repositories/enterpriseRepo');
const assortmentComplianceRepo = require('../repositories/assortmentComplianceRepo');

function svcError(message, statusCode, errorCode) {
  return Object.assign(new Error(message), { statusCode, errorCode });
}

async function getCompliance(visitId, categoryId) {
  const visit = await visitRepo.findById(visitId);
  if (!visit) {
    throw svcError(`Visita ${visitId} no encontrada.`, 404, 'ERR_VISITA_NO_ENCONTRADA');
  }

  const [retailer, enterprise] = await Promise.all([
    retailerRepo.findById(visit.Retailer_id),
    enterpriseRepo.findById(visit.Enterprise_id),
  ]);

  if (!retailer) {
    throw svcError(`Retailer ${visit.Retailer_id} de la visita no encontrado.`, 404, 'ERR_RETAILER_NO_ENCONTRADO');
  }
  if (!enterprise) {
    throw svcError(`Enterprise ${visit.Enterprise_id} de la visita no encontrado.`, 404, 'ERR_ENTERPRISE_NO_ENCONTRADO');
  }

  // supplier_name puede ser NULL (migración 011 no cargada para este enterprise todavía) —
  // no bloquea el cálculo, solo subestima en_exceso_fuera_surtido (ver comentario en el
  // repo). Se loguea para que quede visible en producción, no solo en este archivo.
  if (!enterprise.supplier_name) {
    console.warn(
      `[assortmentCompliance] Enterprise_id=${visit.Enterprise_id} sin supplier_name ` +
      `(migración 011) — en_exceso_fuera_surtido va a quedar subestimado para esta visita.`
    );
  }

  const params = {
    visitId,
    enterpriseId:           visit.Enterprise_id,
    categoryId,
    supermarketchainId:     retailer.Supermarketchain_id,
    format:                 retailer.Formato,
    enterpriseSupplierName: enterprise.supplier_name ?? null,
  };

  const compliance = await assortmentComplianceRepo.calculateAndSave(params);

  await assortmentComplianceRepo.saveShare(compliance.compliance_id, {
    visitId, categoryId, enterpriseId: visit.Enterprise_id,
  });

  const [share, faltantes, enExceso] = await Promise.all([
    assortmentComplianceRepo.getShareByComplianceId(compliance.compliance_id),
    assortmentComplianceRepo.listFaltantes(params),
    assortmentComplianceRepo.listEnExceso(params),
  ]);

  return { compliance, share, faltantes, enExceso };
}

module.exports = { getCompliance };
