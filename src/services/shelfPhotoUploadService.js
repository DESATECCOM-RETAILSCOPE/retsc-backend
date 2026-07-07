// Servicio de carga de fotos de góndola para el dataset de entrenamiento DTC (Issue 7.2).
//
// Flujo de 9 etapas:
//   1. Validar inputs (canal + dtcCategoryId)
//   2. Validar que dtcCategoryId pertenece a las smart categories del enterprise
//      → si la smart category tiene padre, usar el padre para almacenamiento
//        ("Si me da un hijo, grabo el papa")
//   3. Calidad de píxeles (sin dedup) — rechaza fotos borrosas/oscuras/baja resolución
//   4. Azure Vision: caption (stub)
//   5. isShelf: verifica que sea una foto de góndola (stub — siempre true)
//   6. Dedup global por hash (ENTERPRISE_ID IS NULL)
//   7. Subida al blob container global-shelf-training
//   8. Registro en CV: stub
//   9. Insertar anotación pendiente + verificar umbral de entrenamiento
//
// La foto se almacena GLOBALMENTE (ENTERPRISE_ID = null en RETSC_EX_SHELFPHOTO).
// Solo usuarios Admin pueden llamar este servicio (verificado en el router).
//
// TODO: SHELF_UPLOAD_ROLES en .env — actualmente solo Admin.
// TODO: etapa 8 (Custom Vision registro) pendiente de credenciales CV.

const fs = require('fs').promises;

const { validateQualityMetrics } = require('./shelfPhotoQualityService');
const azureVisionService         = require('./azureVisionService');
const customVisionService        = require('./customVisionService');
const { uploadToContainer }      = require('./blobStorageService');
const categoryService            = require('./categoryService');
const shelfPhotoRepo             = require('../repositories/shelfPhotoRepo');
const annotationRepo             = require('../repositories/annotationRepo');
const aiModelRepo                = require('../repositories/aiModelRepo');
const { generateBlobPath }       = require('../utils/shelfPhotoFilenameGenerator');

const CANALES_VALIDOS = ['OMT', 'DTT', 'CONVENIENCE'];

function svcError(msg, statusCode) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  return err;
}

function getShelfContainer() {
  return process.env.AZURE_GLOBAL_SHELF_CONTAINER || 'global-shelf-training';
}

function getThreshold() {
  return parseInt(process.env.SHELF_TRAINING_THRESHOLD || '15', 10);
}

async function uploadShelfPhoto({ buffer, originalname, dtcCategoryId, canal, enterpriseId }) {
  // ── Etapa 1: validar inputs ────────────────────────────────────────────────
  if (!buffer || !buffer.length) throw svcError('No se recibió ninguna imagen.', 400);
  if (!dtcCategoryId) throw svcError('dtcCategoryId es requerido.', 400);
  if (!canal) throw svcError('canal es requerido.', 400);

  const canalNorm = String(canal).toUpperCase();
  if (!CANALES_VALIDOS.includes(canalNorm)) {
    throw svcError(`canal debe ser uno de: ${CANALES_VALIDOS.join(', ')}.`, 400);
  }

  const catId = parseInt(dtcCategoryId, 10);
  if (isNaN(catId)) throw svcError('dtcCategoryId debe ser un entero.', 400);

  // ── Etapa 2: validar que la categoría es del enterprise y es smart ─────────
  const smartCats = await categoryService.listSmartByEnterprise(enterpriseId);
  const match = smartCats.find((c) => c.categoryId === catId);
  if (!match) {
    throw svcError(
      `La categoría ${catId} no es una categoría inteligente del enterprise o no está disponible.`,
      403,
    );
  }

  // "Si me da un hijo, grabo el papa": si la smart category tiene padre, usar el padre
  // para la ruta de blob y el registro en BD.
  const storageCategoryId  = match.parentCategoryId ?? match.categoryId;
  const storageCategoryDsc = match.parentDsc        ?? match.categoryDsc;

  // ── Etapa 3: calidad de píxeles ────────────────────────────────────────────
  const quality = await validateQualityMetrics(buffer);
  if (!quality.accepted) {
    const msgs = {
      LOW_RESOLUTION: 'La imagen tiene resolución insuficiente (mínimo 1280x720).',
      BLURRY_IMAGE:   'La imagen está borrosa. Intentá con una foto más nítida.',
      POOR_LIGHTING:  'La iluminación de la imagen es inadecuada (muy oscura o sobreexpuesta).',
    };
    const msg = msgs[quality.errorCode] || `Calidad insuficiente: ${quality.errorCode}`;
    throw svcError(msg, 422);
  }

  // ── Etapa 4: Azure Vision caption (stub) ──────────────────────────────────
  const visionResult = await azureVisionService.caption(buffer);

  // ── Etapa 5: isShelf check (stub) ─────────────────────────────────────────
  const isShelf = await azureVisionService.isShelf(buffer);
  if (!isShelf) {
    throw svcError('La imagen no parece ser una foto de góndola.', 422);
  }

  // ── Etapa 6: dedup global por hash ────────────────────────────────────────
  const existing = await shelfPhotoRepo.findByHashGlobal(quality.hash);
  if (existing) {
    throw svcError('Esta imagen ya fue cargada anteriormente.', 409);
  }

  // ── Etapa 7: subida al blob ────────────────────────────────────────────────
  const blobPath  = generateBlobPath({ categoryDsc: storageCategoryDsc, canal: canalNorm, hash: quality.hash });
  const container = getShelfContainer();
  const { url: blobUrl } = await uploadToContainer({
    containerName: container,
    blobPath,
    buffer,
    contentType: 'image/jpeg',
  });

  // ── Persiste en RETSC_EX_SHELFPHOTO (ENTERPRISE_ID = null → foto global) ──
  const photo = await shelfPhotoRepo.insert({
    url_blob:          blobUrl,
    enterprise_id:     null,
    category_id:       storageCategoryId,
    photo_date:        new Date(),
    image_hash:        quality.hash,
    quality_status:    quality.qualityStatus,
    quality_error_code: quality.errorCode ?? null,
    width:             quality.metrics.width,
    height:            quality.metrics.height,
    blur_score:        quality.metrics.sharpness,
    brightness:        quality.metrics.brightness,
  });

  // ── Etapa 8: registro en Custom Vision (stub) ─────────────────────────────
  let cvResult = null;
  const model  = await aiModelRepo.findByCategoryId(match.categoryId);
  if (model?.cv_project_id) {
    cvResult = await customVisionService.createImageFromData(buffer, model.cv_project_id, null);
  }

  // ── Etapa 9a: insertar anotación pendiente ────────────────────────────────
  const annotation = await annotationRepo.insert({
    photo_id:         photo.Photo_id,
    dtc_category_id:  storageCategoryId,
    source:           'upload',
    is_validated:     0,
    canal:            canalNorm,
  });

  // ── Etapa 9b: verificar umbral de entrenamiento ───────────────────────────
  const validatedCount = await annotationRepo.countValidatedApprovedByCategoryChannel(
    storageCategoryId, canalNorm,
  );
  const threshold = getThreshold();
  const thresholdReached = validatedCount >= threshold;
  if (thresholdReached) {
    console.log(`[shelfPhoto] umbral alcanzado para categoría ${storageCategoryId} canal ${canalNorm}: ${validatedCount}/${threshold}`);
    // TODO: disparar reentrenamiento de Custom Vision cuando el SDK esté disponible.
  }

  return {
    photoId:          photo.Photo_id,
    blobUrl,
    hash:             quality.hash,
    storageCategoryId,
    storageCategoryDsc,
    annotationId:     annotation.annotation_id,
    canal:            canalNorm,
    validatedCount,
    thresholdReached,
    cvStub:           cvResult?.stub ?? true,
    visionCaption:    visionResult.caption,
  };
}

module.exports = { uploadShelfPhoto };
