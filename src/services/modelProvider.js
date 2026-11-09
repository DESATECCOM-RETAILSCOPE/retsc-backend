// Ciclo 5 (A4) — PUNTO ÚNICO de acceso al proveedor de modelos de detección.
//
// Microsoft anunció el retiro de Azure Custom Vision (soporte hasta el 25-sep-2028). Todo el
// pipeline (sincronización de cajitas, entrenamiento, publicación, predicción, provisioning)
// habla con el proveedor SOLO a través de este módulo. Migrar después a Azure Machine Learning
// (AutoML) será reimplementar estas funciones, no reescribir el pipeline.
//
// Implementación actual: Custom Vision (customVisionService = training API,
// customVisionPredictService = prediction API). Los `require` son DIFERIDOS (dentro de cada
// función) a propósito: así los tests que stubean './customVisionService' vía require.cache
// siguen funcionando sin cambios, aunque este módulo ya esté cargado.

const cv        = () => require('./customVisionService');
const cvPredict = () => require('./customVisionPredictService');

// Formato del Resource ID de ARM del recurso de PREDICCIÓN (requerido para publicar). Un ID
// truncado (sin /accounts/{nombre}) fue la causa del BadRequestInvalidPublishTarget de agosto.
const PREDICTION_RESOURCE_ID_RE =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+$/i;
const PREDICTION_RESOURCE_ID_MAX_LENGTH = 200; // RETSC_AI_DETECTION_MODELS.prediction_resource_id VARCHAR(200)

// Lee el Resource ID de predicción SIEMPRE del .env (A4: nunca de un valor guardado a mano).
// Devuelve { ok: true, value } o { ok: false, error } — no lanza.
function leerPredictionResourceId() {
  const raw = (process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID || '').trim();
  if (!raw) return { ok: false, error: 'CUSTOM_VISION_PREDICTION_RESOURCE_ID está vacía en el .env' };
  if (raw.length > PREDICTION_RESOURCE_ID_MAX_LENGTH) {
    return { ok: false, error: `CUSTOM_VISION_PREDICTION_RESOURCE_ID mide ${raw.length} caracteres (máx. ${PREDICTION_RESOURCE_ID_MAX_LENGTH})` };
  }
  if (!PREDICTION_RESOURCE_ID_RE.test(raw)) {
    return { ok: false, error: 'CUSTOM_VISION_PREDICTION_RESOURCE_ID no tiene el formato /subscriptions/…/providers/Microsoft.CognitiveServices/accounts/{nombre} (¿está truncada?)' };
  }
  return { ok: true, value: raw };
}

module.exports = {
  // Configuración
  estaConfigurado:            (...a) => cv().isConfigured(...a),
  leerPredictionResourceId,

  // Proyecto / tags
  crearProyecto:              (...a) => cv().createProject(...a),
  listarTags:                 (...a) => cv().listTags(...a),
  asegurarTag:                (...a) => cv().ensureTag(...a),
  renombrarTag:               (...a) => cv().updateTag(...a),
  borrarTag:                  (...a) => cv().deleteTag(...a),

  // Imágenes / cajitas
  subirImagen:                (...a) => cv().createImageFromData(...a),
  borrarImagenes:             (...a) => cv().deleteImages(...a),
  crearRegiones:              (...a) => cv().createImageRegions(...a),
  borrarRegion:               (...a) => cv().deleteImageRegion(...a),
  borrarRegiones:             (...a) => cv().deleteImageRegions(...a),
  listarImagenesPorTag:       (...a) => cv().getTaggedImages(...a),

  // Entrenamiento / publicación
  entrenar:                   (...a) => cv().trainProject(...a),
  consultarIteracion:         (...a) => cv().getIteration(...a),
  listarIteraciones:          (...a) => cv().listIterations(...a),
  metricasIteracion:          (...a) => cv().getIterationPerformance(...a),
  publicar:                   (...a) => cv().publishIteration(...a),

  // Predicción
  predecir:                   (...a) => cvPredict().predecirFoto(...a),
};
