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
const shelfPhotoRepo           = require('../repositories/shelfPhotoRepo');
const blobStorageService       = require('./blobStorageService');
const processReadinessService  = require('./processReadinessService');

// image_url en RETSC_OP_SKUS se guarda sin firmar (ver blobStorageService.signBlobUrl) — el
// storage account no permite lectura pública anónima, así que hay que firmar acá antes de
// devolverlo al mobile.
async function signProductPhotos(rows) {
  return Promise.all(rows.map(async (row) => ({
    ...row,
    image_url: await blobStorageService.signBlobUrl(row.image_url),
  })));
}

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

  // Red de seguridad (ver processReadinessService.js): el mobile ya bloquea la entrada al
  // módulo de captura si falta alguna de estas condiciones (GET /api/readiness, llamado desde
  // VisitCaptureScreen), pero si ese chequeo se bypassea por una caché vieja o una condición
  // de carrera, esto evita volver a producir el crash real de 2026-10-23 (NULL crudo en
  // cumplimiento_pct porque Enterprise_id=2 nunca tuvo surtido cargado) — un 409 con mensaje
  // accionable en su lugar.
  const readiness = await processReadinessService.checkReadiness({
    enterpriseId: visit.Enterprise_id,
    retailerId:   visit.Retailer_id,
    categoryId,
  });
  if (!readiness.ready) {
    throw svcError(
      readiness.blockers.map((b) => b.message).join(' '),
      409,
      'ERR_NOT_READY_FOR_COMPLIANCE',
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

  const [share, faltantesRaw, enExcesoRaw] = await Promise.all([
    assortmentComplianceRepo.getShareByComplianceId(compliance.compliance_id),
    assortmentComplianceRepo.listFaltantes(params),
    assortmentComplianceRepo.listEnExceso(params),
  ]);

  const [faltantes, enExceso] = await Promise.all([
    signProductPhotos(faltantesRaw),
    signProductPhotos(enExcesoRaw),
  ]);

  return { compliance, share, faltantes, enExceso };
}

// Resumen de cumplimiento por categoría para la pantalla de detalle de "Visitas" (mobile) —
// a diferencia de getCompliance(), NO recalcula/inserta nada: lee la última fila ya
// persistida por categoría (la que quedó guardada cuando esa categoría se procesó durante
// la visita, vía getCompliance() desde ResultsScreen). Si una categoría nunca llegó a
// calcularse (ej. el usuario descartó la visita antes de llegar al ResultsScreen de esa
// categoría), compliance sale null para esa entrada en vez de forzar un cálculo nuevo.
async function getComplianceSummaryForVisit(visitId) {
  const categoryIds = await shelfPhotoRepo.listCategoryIdsByVisit(visitId);
  return Promise.all(categoryIds.map(async (categoryId) => ({
    categoryId,
    compliance: await assortmentComplianceRepo.getLatestByVisitCategory(visitId, categoryId),
  })));
}

module.exports = { getCompliance, getComplianceSummaryForVisit };
