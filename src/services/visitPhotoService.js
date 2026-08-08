// Pasos 1 + 2 de la guía "Fotos de Visita" v1.9 — guarda una foto de visita YA validada por
// el mobile (blur/luz/encuadre OK) en Blob Storage y la registra en RETSC_EX_SHELFPHOTO,
// amarrada al Visit_id abierto en el Paso 0. Dispara el Paso 3+ (detección) en background.
//
// Distinto de shelfPhotoUploadService.js (fotos GLOBALES de entrenamiento, sin enterprise,
// sin visita, con su propio gate de calidad de 8 etapas — Issues 7.1/7.2): este es el flujo
// de PRODUCCIÓN, una foto por enterprise/PDV/visita real. La guía es explícita (sección 3):
// "La foto llega al backend YA validada por el mobile (blur, luz, encuadre) — aquí no se
// vuelve a validar eso, solo se guarda" — a propósito NO se llama a
// shelfPhotoQualityService/imageQualityValidator aquí, aunque esas funciones existan y se
// usen en el otro flujo. quality_status/blur_score/brightness llegan ya calculados en el
// body y se guardan tal cual, como registro de auditoría (ver guía, Paso 2).
//
// NOTA: la guía no pide un paso de deduplicación por hash para este flujo (a diferencia del
// de entrenamiento). Igual se calcula y guarda image_hash — la columna ya existe en
// RETSC_EX_SHELFPHOTO y es información de auditoría gratis — pero no se usa para rechazar
// la subida.

const crypto = require('crypto');

const { uploadToContainer } = require('./blobStorageService');
const { hashBuffer }        = require('../utils/imageHasher');
const visitRepo             = require('../repositories/visitRepo');
const categoryRepo          = require('../repositories/categoryRepo');
const shelfPhotoRepo        = require('../repositories/shelfPhotoRepo');
const detectionPipelineService = require('./detectionPipelineService');

const VISIT_SHELF_CONTAINER = () =>
  process.env.AZURE_VISIT_SHELF_CONTAINER || 'enterprise-shelf-visits';

function svcError(message, statusCode, errorCode) {
  return Object.assign(new Error(message), { statusCode, errorCode });
}

function parseIntOrThrow(value, label, errorCode) {
  const n = parseInt(value, 10);
  if (isNaN(n)) throw svcError(`${label} es requerido y debe ser un número entero.`, 400, errorCode);
  return n;
}

// @param buffer         - contenido de la imagen (ya leído del archivo multer)
// @param visitId        - Visit_id devuelto al abrir la visita (Paso 0)
// @param categoryId     - categoría seleccionada en el mobile para ESTA foto
// @param shelfunitId     - opcional
// @param qualityStatus, blurScore, brightness - ya calculados por el mobile (Paso 3, guía)
async function uploadVisitPhoto({ buffer, visitId, categoryId, shelfunitId, qualityStatus, blurScore, brightness, uploadedBy }) {
  const visitIdInt    = parseIntOrThrow(visitId, 'visitId', 'ERR_VISIT_ID_REQUERIDO');
  const categoryIdInt = parseIntOrThrow(categoryId, 'categoryId', 'ERR_CATEGORIA_REQUERIDA');

  const visit = await visitRepo.findById(visitIdInt);
  if (!visit) {
    throw svcError(`Visita ${visitIdInt} no encontrada.`, 404, 'ERR_VISITA_NO_ENCONTRADA');
  }
  if (visit.Status !== 'OPEN') {
    throw svcError(`La visita ${visitIdInt} ya está ${visit.Status} — no se pueden agregar más fotos.`, 409, 'ERR_VISITA_CERRADA');
  }

  const category = await categoryRepo.findById(categoryIdInt);
  if (!category) {
    throw svcError(`Categoría ${categoryIdInt} no encontrada.`, 404, 'ERR_CATEGORIA_NO_ENCONTRADA');
  }

  console.log(`[visitPhoto] inicio carga — visit_id=${visitIdInt}, categoría=${categoryIdInt} (${category.Category_dsc}), uploadedBy=${uploadedBy}`);

  const hash = await hashBuffer(buffer);

  // Path fijo de la guía (sección 3.1):
  //   enterprise-shelf-visits/{enterprise_id}/{pdv_id}/{session_id}/{category_id}/
  // pdv_id = Retailer_id de la visita (el PDV seleccionado en el Paso 0); session_id = Visit_id.
  const filename = `${Math.floor(Date.now() / 1000)}-${crypto.randomUUID().slice(0, 8)}.jpg`;
  const blobPath = `${visit.Enterprise_id}/${visit.Retailer_id}/${visit.Visit_id}/${categoryIdInt}/${filename}`;

  const { url: blobUrl } = await uploadToContainer({
    containerName: VISIT_SHELF_CONTAINER(),
    blobPath,
    buffer,
    contentType: 'image/jpeg',
  });

  console.log(`[visitPhoto] blob subido — path=${blobPath}`);

  const photo = await shelfPhotoRepo.insert({
    retailer_id:        visit.Retailer_id,
    shelfunit_id:        shelfunitId ? parseInt(shelfunitId, 10) : null,
    photo_date:         new Date(),
    url_blob:           blobUrl,
    enterprise_id:      visit.Enterprise_id,
    category_id:        categoryIdInt,
    visit_id:           visitIdInt,
    image_hash:         hash,
    quality_status:     qualityStatus ?? null,
    quality_error_code: null,
    width:              null,
    height:             null,
    blur_score:         blurScore != null ? parseFloat(blurScore) : null,
    brightness:         brightness != null ? parseFloat(brightness) : null,
  });

  const photoId = photo.Photo_id;
  console.log(`[visitPhoto] foto registrada — Photo_id=${photoId}`);

  // Pasos 3-5 (detección + identificación de producto) corren en background — el mobile ya
  // tiene su photoId y no necesita esperar a Custom Vision/OCR/búsqueda de SKU para el 201.
  // Mismo patrón fire-and-forget que aiInfrastructureService.provisionForCategory().
  setImmediate(() => {
    detectionPipelineService.processPhotoDetection(photoId, buffer, categoryIdInt)
      .catch(err => console.error(`[visitPhoto] Photo_id=${photoId} — error en pipeline de detección:`, err.message));
  });

  return {
    photoId,
    visitId: visitIdInt,
    categoryId: categoryIdInt,
    blobPath,
    blobUrl,
  };
}

module.exports = { uploadVisitPhoto };
