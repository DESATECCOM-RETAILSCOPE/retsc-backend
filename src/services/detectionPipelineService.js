// Pasos 3 + 4 (+ dispara el Paso 5) de la guía "Fotos de Visita" v1.9 — orquesta la
// detección de cajitas sobre una foto de visita ya guardada, contra el modelo PUBLICADO de
// Custom Vision de su categoría.
//
// Se llama fire-and-forget desde visitPhotoService.uploadVisitPhoto() justo después de
// insertar la foto (mismo patrón que aiInfrastructureService.provisionForCategory() —
// background, no bloquea la respuesta HTTP de la subida): el mobile ya tiene su photoId,
// no necesita esperar a Custom Vision + OCR + búsqueda de SKU para recibir el 201.
//
// 2026-08-29 — antes este archivo dependía de un endpoint intermedio que iba a construir
// Joel (visionDetectionService.js, ver ese archivo — queda sin uso, no se borra por el
// contexto documentado en sus comentarios). Nunca se entregó, así que ahora se llama
// directo a customVisionPredictService, que habla con la Prediction API de Custom Vision
// con las credenciales de este backend (CV_PREDICTION_ENDPOINT/KEY).
//
// NOTA: la guía (sección 5.1, callout "Si no hay ningún modelo PUBLISHED todavía") es
// explícita en que la ausencia de modelo NO debe romper el flujo completo de la visita —
// la detección queda pendiente. Mismo criterio para cualquier error de Custom Vision
// (credenciales faltantes, timeout, 401, etc.): predecirFoto() lanza con un `.code`
// descriptivo, y acá se atrapa para dejar la foto "pendiente" en vez de tumbar este job de
// background (que de todas formas ya corre fire-and-forget, sin nadie esperando la
// respuesta HTTP).

const shelfPhotoDetectionRepo = require('../repositories/shelfPhotoDetectionRepo');
const detectionPipelineLogRepo = require('../repositories/detectionPipelineLogRepo');
const customVisionPredictService = require('./customVisionPredictService');
const productIdentificationService = require('./productIdentificationService');

// El log nunca debe tumbar el pipeline (es diagnóstico, no funcional) — si falla el INSERT
// (ej. la migración 012 no corrió todavía en este ambiente), se loguea y se sigue.
async function registrarLog(entry) {
  try {
    await detectionPipelineLogRepo.insert(entry);
  } catch (err) {
    console.error(`[detectionPipeline] Photo_id=${entry.photoId} — no se pudo guardar el log:`, err.message);
  }
}

// photoId: Photo_id ya insertado en RETSC_EX_SHELFPHOTO. buffer: la imagen ya validada por
// el mobile. categoryId: category_id de esa foto (Paso 3 de la guía: el modelo depende
// SOLO de la categoría, nunca del canal).
//
// Devuelve un resumen { pending, reason?, detections } — pensado para logging/diagnóstico,
// no para la respuesta HTTP (esto corre después de que esa respuesta ya se envió).
async function processPhotoDetection(photoId, buffer, categoryId) {
  const inicio = Date.now();
  let resultado;
  try {
    resultado = await customVisionPredictService.predecirFoto(buffer, categoryId, photoId);
  } catch (err) {
    console.warn(
      `[detectionPipeline] Photo_id=${photoId} — no se pudo predecir (${err.code || 'ERROR'}): ${err.message}` +
      (err.azureBody ? ` — azureBody=${err.azureBody}` : '')
    );
    await registrarLog({
      photoId, categoryId, status: 'ERROR', reasonCode: err.code || 'PREDICT_ERROR',
      attempts: err.intentos, errorMessage: err.message, durationMs: Date.now() - inicio,
    });
    return { pending: true, reason: err.code || 'PREDICT_ERROR', detections: [] };
  }

  if (resultado.detecciones.length === 0) {
    console.log(
      `[detectionPipeline] Photo_id=${photoId} — Custom Vision devolvió ${resultado.totalDevueltas} ` +
      `predicción(es) (iteración ${resultado.iteracion}), ninguna superó el umbral ${resultado.umbralAplicado}.`
    );
    await registrarLog({
      photoId, categoryId, status: 'PENDING', reasonCode: 'NO_DETECTIONS_ABOVE_THRESHOLD',
      rawPredictions: resultado.totalDevueltas, detectionsSaved: 0,
      thresholdApplied: resultado.umbralAplicado, attempts: resultado.intentos,
      durationMs: Date.now() - inicio,
    });
    return { pending: false, detections: [] };
  }

  const inserted = await shelfPhotoDetectionRepo.bulkInsertDetections(resultado.detecciones);
  console.log(
    `[detectionPipeline] Photo_id=${photoId} — ${inserted.length}/${resultado.totalDevueltas} cajita(s) ` +
    `sobre el umbral (${resultado.iteracion}), identificando producto...`
  );
  await registrarLog({
    photoId, categoryId, status: 'SUCCESS',
    rawPredictions: resultado.totalDevueltas, detectionsSaved: inserted.length,
    thresholdApplied: resultado.umbralAplicado, attempts: resultado.intentos,
    durationMs: Date.now() - inicio,
  });

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
