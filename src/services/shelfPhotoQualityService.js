// Servicio de validación de calidad de fotos de góndola (Issue 7.1).
//
// Orquesta los 4 criterios del issue antes de aceptar una foto en el dataset de
// entrenamiento:
//   1. Resolución >= 1280x720   → LOW_RESOLUTION
//   2. Nitidez score > 0.6      → BLURRY_IMAGE
//   3. Brillo en [30, 220]      → POOR_LIGHTING
//   4. Hash no duplicado        → DUPLICATE_IMAGE   (scope: por enterprise)
//
// Regla clave del issue: una foto mala degrada el modelo para TODOS los enterprises,
// por eso esta puerta debe correr ANTES de subir la foto al dataset / anotarla.
//
// Este servicio NO hace el INSERT ni sube el blob: devuelve el veredicto + métricas
// para que el flujo de carga (aún no existe en este repo) decida qué hacer. Así queda
// testeable y desacoplado del pipeline de subida.
//
// Uso esperado desde el futuro controller de carga:
//   const v = await shelfPhotoQualityService.assessPhoto(file.path, { enterpriseId });
//   if (!v.accepted) { ...rechazar con v.errorCode... }
//   else { ...subir blob + shelfPhotoRepo.insert({ ..., image_hash: v.hash, ... })... }

const { hashFile, hashBuffer } = require('../utils/imageHasher');
const { validateImageQuality } = require('../utils/imageQualityValidator');
const shelfPhotoRepo = require('../repositories/shelfPhotoRepo');

// Prioridad del código de error cuando falla más de un criterio: quality_error_code
// es una sola columna, así que se reporta el primero según el orden del issue.
const ERROR_PRIORITY = ['LOW_RESOLUTION', 'BLURRY_IMAGE', 'POOR_LIGHTING', 'DUPLICATE_IMAGE'];

function firstByPriority(errors) {
  for (const code of ERROR_PRIORITY) {
    if (errors.includes(code)) return code;
  }
  return errors[0] ?? null;
}

// input: ruta de archivo (string) o Buffer de la imagen.
// Devuelve { accepted, errorCode, errors[], hash, qualityStatus, metrics }.
async function assessPhoto(input, { enterpriseId } = {}) {
  if (enterpriseId === undefined || enterpriseId === null) {
    throw Object.assign(new Error('enterpriseId es requerido para el dedup por enterprise.'), { statusCode: 400 });
  }

  const errors = [];

  // Criterios de píxeles: resolución, nitidez, brillo.
  const { errors: pixelErrors, metrics } = await validateImageQuality(input);
  errors.push(...pixelErrors);

  // Hash SHA-256 del archivo — reutiliza el util del pipeline de imágenes de SKU.
  const hash = typeof input === 'string' ? await hashFile(input) : await hashBuffer(input);

  // Criterio 4: duplicado (consulta BD, scope por enterprise).
  const existing = await shelfPhotoRepo.findByHash(hash, enterpriseId);
  if (existing) errors.push('DUPLICATE_IMAGE');

  const accepted = errors.length === 0;
  return {
    accepted,
    errorCode: accepted ? null : firstByPriority(errors),
    errors,
    hash,
    qualityStatus: accepted ? 'PASSED' : 'REJECTED',
    metrics, // { width, height, brightness, sharpness, variance }
  };
}

// Helper para el flujo de fotos GLOBALES (Issue 7.2): ejecuta solo los criterios de
// píxeles (resolución, nitidez, brillo) sin el dedup por enterprise.
//
// El dedup de fotos globales (sin enterprise) se hace por separado en
// shelfPhotoUploadService usando shelfPhotoRepo.findByHashGlobal().
// Se exporta para que ese servicio no duplique la lógica de métricas.
//
// Devuelve { accepted, errorCode, errors[], hash, metrics } — sin qualityStatus ni
// el campo 'errors[]' de DUPLICATE_IMAGE que solo aplica al flujo por enterprise.
async function validateQualityMetrics(input) {
  const errors = [];

  const { errors: pixelErrors, metrics } = await validateImageQuality(input);
  errors.push(...pixelErrors);

  const hash = typeof input === 'string' ? await hashFile(input) : await hashBuffer(input);

  const accepted  = errors.length === 0;
  return {
    accepted,
    errorCode: accepted ? null : firstByPriority(errors),
    errors,
    hash,
    metrics,
  };
}

module.exports = { assessPhoto, validateQualityMetrics };
