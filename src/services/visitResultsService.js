// Paso 6 de la guía "Fotos de Visita" v1.9 (secciones 8.1-8.3) — arma la respuesta para el
// dashboard mobile: share de góndola por marca + faltantes del surtido propio del cliente.
//
// NOTA sobre el formato de la respuesta: a propósito se usan los nombres literales en
// español que trae la guía (visit_id, share_de_gondola, marca, conteo, share, faltantes,
// sku_id, producto, sin_identificar) en vez de camelCase — a diferencia de la convención
// general del repo (ver CLAUDE.md, "Column naming convention"), este es un contrato
// explícito ya acordado con el mobile (la guía lo da como el JSON exacto que espera esa
// pantalla), no una fila de MSSQL que haya que normalizar antes de exponerla.
//
// Una visita puede cubrir varias categorías (guía sección 1) — los faltantes se calculan
// por cada categoría que la visita realmente tocó y se combinan en un solo array.

const visitRepo               = require('../repositories/visitRepo');
const shelfPhotoRepo          = require('../repositories/shelfPhotoRepo');
const shelfPhotoDetectionRepo = require('../repositories/shelfPhotoDetectionRepo');
const assortmentRepo          = require('../repositories/assortmentRepo');

function svcError(message, statusCode, errorCode) {
  return Object.assign(new Error(message), { statusCode, errorCode });
}

// GET /api/sessions/:id/results — :id es el Visit_id (la guía llama "session_id" al mismo
// valor en el path de Blob Storage, sección 3.1: "session_id es el Visit_id que te devolvió
// ese INSERT" del Paso 0).
async function getResults(visitId) {
  const visit = await visitRepo.findById(visitId);
  if (!visit) {
    throw svcError(`Visita ${visitId} no encontrada.`, 404, 'ERR_VISITA_NO_ENCONTRADA');
  }

  const [shareRows, sinIdentificar, categoryIds, detectedSkuIds] = await Promise.all([
    shelfPhotoDetectionRepo.shareDeGondolaByVisit(visitId),
    shelfPhotoDetectionRepo.countUnidentifiedByVisit(visitId),
    shelfPhotoRepo.listCategoryIdsByVisit(visitId),
    shelfPhotoDetectionRepo.listDetectedSkuIdsByVisit(visitId),
  ]);

  const faltantesPerCategory = await Promise.all(
    categoryIds.map(categoryId =>
      assortmentRepo.listMissingMandatory(visit.Enterprise_id, categoryId, detectedSkuIds)
    )
  );

  return {
    visit_id: visitId,
    share_de_gondola: shareRows.map(row => ({
      marca:   row.Brand,
      conteo:  row.conteo,
      share:   row.share,
    })),
    faltantes: faltantesPerCategory.flat().map(row => ({
      sku_id:   row.sku_id,
      producto: row.Product_dsc,
    })),
    sin_identificar: sinIdentificar,
  };
}

module.exports = { getResults };
