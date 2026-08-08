// Pasos 3 + 4 (+ dispara el Paso 5) de la guía "Fotos de Visita" v1.9 — orquesta la
// detección de cajitas sobre una foto de visita ya guardada, contra el modelo PUBLICADO de
// Custom Vision de su categoría.
//
// Se llama fire-and-forget desde visitPhotoService.uploadVisitPhoto() justo después de
// insertar la foto (mismo patrón que aiInfrastructureService.provisionForCategory() —
// background, no bloquea la respuesta HTTP de la subida): el mobile ya tiene su photoId,
// no necesita esperar a Custom Vision + OCR + búsqueda de SKU para recibir el 201.
//
// NOTA: la guía (sección 5.1, callout "Si no hay ningún modelo PUBLISHED todavía") es
// explícita en que la ausencia de modelo NO debe romper el flujo completo de la visita —
// la detección queda pendiente. Se aplica el mismo criterio si el endpoint de Joel
// (visionDetectionService) tampoco está configurado todavía: ninguno de los dos casos
// lanza, ambos solo dejan la foto sin detecciones por ahora.

const aiModelRepo            = require('../repositories/aiModelRepo');
const shelfPhotoDetectionRepo = require('../repositories/shelfPhotoDetectionRepo');
const visionDetectionService  = require('./visionDetectionService');
const productIdentificationService = require('./productIdentificationService');

// photoId: Photo_id ya insertado en RETSC_EX_SHELFPHOTO. buffer: la imagen ya validada por
// el mobile. categoryId: category_id de esa foto (Paso 3 de la guía: el modelo depende
// SOLO de la categoría, nunca del canal).
//
// Devuelve un resumen { pending, reason?, detections } — pensado para logging/diagnóstico,
// no para la respuesta HTTP (esto corre después de que esa respuesta ya se envió).
async function processPhotoDetection(photoId, buffer, categoryId) {
  const model = await aiModelRepo.findPublishedByCategoryId(categoryId);
  if (!model) {
    console.warn(`[detectionPipeline] Photo_id=${photoId} — sin modelo PUBLISHED/READY para category_id=${categoryId}. Detección pendiente.`);
    return { pending: true, reason: 'NO_PUBLISHED_MODEL', detections: [] };
  }

  const { pending, regions } = await visionDetectionService.detectRegions(buffer, categoryId);
  if (pending) {
    console.warn(`[detectionPipeline] Photo_id=${photoId} — endpoint de detección (Joel) no disponible todavía. Detección pendiente.`);
    return { pending: true, reason: 'NO_DETECTION_ENDPOINT', detections: [] };
  }

  if (regions.length === 0) {
    console.log(`[detectionPipeline] Photo_id=${photoId} — el modelo no detectó ninguna cajita.`);
    return { pending: false, detections: [] };
  }

  const inserted = await shelfPhotoDetectionRepo.bulkInsert(photoId, model.detection_model_id, regions);
  console.log(`[detectionPipeline] Photo_id=${photoId} — ${inserted.length} cajita(s) detectada(s), identificando producto...`);

  // Paso 5 — no se espera aquí a que termine para "cerrar" el Paso 4 conceptualmente, pero
  // sí se await-ea dentro de esta misma función de background para que un error de
  // identificación quede registrado junto con el resto de este procesamiento, en vez de
  // convertirse en una promesa huérfana sin nadie que la observe.
  try {
    await productIdentificationService.identifyDetections(buffer, inserted);
  } catch (err) {
    console.error(`[detectionPipeline] Photo_id=${photoId} — error identificando productos:`, err.message);
  }

  return { pending: false, detections: inserted };
}

module.exports = { processPhotoDetection };
