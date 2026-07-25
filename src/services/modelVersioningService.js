// Servicio de versioning y re-entrenamiento de modelos de detección (Issue 8.5).
//
// Gestiona el ciclo de vida de los modelos de Custom Vision por categoría:
//
// Reglas (Issue 8.5):
//   - model_version incrementa con cada entrenamiento.
//   - Mínimo 20 fotos nuevas (con anotación validada) para re-entrenar.
//   - Nueva versión con métricas peores (mAP) requiere aprobación manual.
//   - Se conserva la versión anterior como rollback (is_active=0, no se borra).
//
// Estados (columna status):
//   PENDING | TRAINING | READY | ERROR  (existentes)
//   AWAITING_APPROVAL  → versión entrenada con mAP peor, esperando aprobación manual
//   REJECTED           → versión rechazada; la anterior sigue activa
//
// Custom Vision: el entrenamiento real está stubbeado (customVisionService no tiene
// credenciales). Este servicio orquesta el ciclo de vida; la llamada de entrenamiento
// se delega y las métricas llegan vía completeRetrain (en producción, desde el callback
// o un poller de Custom Vision; hoy, inyectadas).
//
// Config (.env):
//   MODEL_RETRAIN_MIN_PHOTOS=20   — mínimo de fotos nuevas para permitir re-entrenar
//   MODEL_METRIC_TOLERANCE=0      — margen: la nueva es "peor" si mean_ap < activo - tol

const aiModelRepo         = require('../repositories/aiModelRepo');
const annotationRepo      = require('../repositories/annotationRepo');
const customVisionService = require('./customVisionService');

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function minPhotos() {
  const v = Number(process.env.MODEL_RETRAIN_MIN_PHOTOS);
  return Number.isFinite(v) && v > 0 ? v : 20;
}

function metricTolerance() {
  const v = Number(process.env.MODEL_METRIC_TOLERANCE);
  return Number.isFinite(v) ? v : 0;
}

// Una versión es "peor" si su mAP cae por debajo del activo menos la tolerancia.
// Sin baseline (activo sin mAP) no hay con qué comparar → no se considera peor.
function isWorse(newMap, activeMap) {
  if (activeMap === null || activeMap === undefined) return false;
  if (newMap === null || newMap === undefined) return true; // sin métricas → conservador
  return newMap < activeMap - metricTolerance();
}

// ¿Se puede re-entrenar? Cuenta fotos nuevas validadas desde el último trained_at.
async function canRetrain(categoryId) {
  const active = await aiModelRepo.findByCategoryId(categoryId);
  const since = active?.trained_at ?? null;
  const newPhotos = await annotationRepo.countNewValidatedPhotos(categoryId, since);
  const required = minPhotos();
  return {
    categoryId,
    canRetrain: newPhotos >= required,
    newPhotos,
    required,
    activeVersion: active?.model_version ?? null,
    since,
  };
}

// Inicia un re-entrenamiento: valida la regla de fotos, incrementa la versión e
// inserta la nueva versión en estado TRAINING (inactiva). Dispara el entrenamiento
// (stub). Las métricas se cargan luego con completeRetrain.
async function startRetrain(categoryId) {
  const check = await canRetrain(categoryId);
  if (!check.canRetrain) {
    throw httpError(
      `Se requieren al menos ${check.required} fotos nuevas validadas para re-entrenar (hay ${check.newPhotos}).`,
      409,
    );
  }

  const active = await aiModelRepo.findByCategoryId(categoryId);
  const nextVersion = (await aiModelRepo.getMaxVersion(categoryId)) + 1;

  const newModel = await aiModelRepo.insert({
    categoryId,
    modelName:           active?.model_name ?? `model-cat-${categoryId}`,
    status:              'TRAINING',
    modelVersion:        nextVersion,
    confidenceThreshold: active?.confidence_threshold ?? 0.5,
    isActive:            0, // la versión anterior sigue activa hasta validar la nueva
  });

  // Delegación al entrenamiento real (stub mientras no haya credenciales).
  if (customVisionService.isConfigured()) {
    // TODO: cuando exista customVisionService.triggerTraining(projectId), invocarlo aquí.
    console.warn('[modelVersioning] Custom Vision configurado, pero triggerTraining aún no implementado.');
  } else {
    console.log(`[modelVersioning] CV no configurado: versión ${nextVersion} de categoría ${categoryId} queda en TRAINING (stub).`);
  }

  return newModel;
}

// Completa el entrenamiento de una versión: guarda métricas y decide si se activa
// automáticamente (mAP >= activo) o queda esperando aprobación manual (mAP peor).
async function completeRetrain(modelId, metrics = {}) {
  const model = await aiModelRepo.findById(modelId);
  if (!model) throw httpError(`Modelo ${modelId} no encontrado.`, 404);

  const saved = await aiModelRepo.saveMetrics(modelId, {
    precisionScore: metrics.precision,
    recallScore:    metrics.recall,
    meanAp:         metrics.meanAp,
    metricsJson:    metrics.raw ? JSON.stringify(metrics.raw) : null,
  });

  // Comparar contra la versión actualmente activa (la anterior; la nueva está inactiva).
  const active = await aiModelRepo.findByCategoryId(model.category_id);
  const worse = active ? isWorse(metrics.meanAp, active.mean_ap) : false;

  if (worse) {
    const updated = await aiModelRepo.updateStatus(modelId, 'AWAITING_APPROVAL');
    return { model: updated, decision: 'AWAITING_APPROVAL', comparedTo: active.model_version };
  }

  const activated = await aiModelRepo.setActiveVersion(model.category_id, modelId);
  return { model: activated, decision: 'ACTIVATED', comparedTo: active?.model_version ?? null };
}

// Aprueba manualmente una versión que quedó en AWAITING_APPROVAL → la activa.
async function approveVersion(modelId, adminId) {
  const model = await aiModelRepo.findById(modelId);
  if (!model) throw httpError(`Modelo ${modelId} no encontrado.`, 404);
  if (model.status !== 'AWAITING_APPROVAL') {
    throw httpError(`La versión no está esperando aprobación (status actual: ${model.status}).`, 409);
  }
  await aiModelRepo.setApproval(modelId, adminId);
  const activated = await aiModelRepo.setActiveVersion(model.category_id, modelId);
  return activated;
}

// Rechaza una versión en AWAITING_APPROVAL → queda REJECTED; la anterior sigue activa.
async function rejectVersion(modelId, adminId) {
  const model = await aiModelRepo.findById(modelId);
  if (!model) throw httpError(`Modelo ${modelId} no encontrado.`, 404);
  if (model.status !== 'AWAITING_APPROVAL') {
    throw httpError(`La versión no está esperando aprobación (status actual: ${model.status}).`, 409);
  }
  await aiModelRepo.setApproval(modelId, adminId); // registra quién la revisó
  return aiModelRepo.updateStatus(modelId, 'REJECTED');
}

// Rollback: reactiva una versión anterior de la categoría.
async function rollback(categoryId, version) {
  const versions = await aiModelRepo.listByCategory(categoryId);
  const target = versions.find((m) => m.model_version === version);
  if (!target) throw httpError(`No existe la versión ${version} para la categoría ${categoryId}.`, 404);
  return aiModelRepo.setActiveVersion(categoryId, target.detection_model_id);
}

// Lista las versiones de una categoría (para la UI de gestión).
async function listVersions(categoryId) {
  return aiModelRepo.listByCategory(categoryId);
}

// GET /api/models — listado global (todas las categorías, todas las versiones).
// Alimenta el ítem "Modelos de detección" del menú ADMIN_DTC.
//
// NOTA (menú por rol, 2026-07-25): aiModelRepo.listAll() hace `SELECT *` sobre
// RETSC_AI_DETECTION_MODELS, así que nunca referencia por nombre las columnas de
// la migración 006 (precision_score/recall_score/mean_ap/metrics_json) — no hay
// "Invalid column name" posible aunque esa migración no esté aplicada, porque
// `SELECT *` simplemente no devuelve columnas que no existen en la tabla real.
// Verificado contra la BD real (2026-07-25): migración 006 sigue sin aplicar y
// listAll() responde igual, solo que los modelos no traen esas 4 columnas.
async function listAll() {
  return aiModelRepo.listAll();
}

module.exports = {
  canRetrain,
  startRetrain,
  completeRetrain,
  approveVersion,
  rejectVersion,
  rollback,
  listVersions,
  listAll,
  // exportadas para tests unitarios
  isWorse,
};
