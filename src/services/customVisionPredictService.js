// Servicio de predicción de Azure Custom Vision para el pipeline de fotos de visita.
//
// Recibe los bytes de una foto de góndola y devuelve las cajitas detectadas por el modelo
// publicado de la categoría correspondiente. Reemplaza el adaptador stub que esperaba un
// endpoint intermedio de Joel (ver visionDetectionService.js, ahora sin uso) — ese endpoint
// nunca se entregó, así que este servicio llama directo a la Prediction API de Custom
// Vision con las credenciales propias de este backend.
//
// IMPORTANTE — recurso de Prediction, no de Training:
//   En Azure existen DOS recursos distintos de Custom Vision:
//     - cvrscopeaiprod              → training (subir imágenes, entrenar, publicar)
//     - cvrscopeaiprod-Prediction   → prediction (preguntarle al modelo publicado)
//   Cada uno tiene su propio endpoint y su propia llave, y NO son intercambiables.
//   Usar el de training para predecir devuelve 401. Ese error ya ocurrió en este proyecto.
//
// El header de autenticación es 'Prediction-Key'. No 'Ocp-Apim-Subscription-Key',
// no 'Authorization: Bearer'.
//
// Acceso a datos: sigue el patrón del repo (src/repositories/, no SQL inline en el
// service) — la fila del modelo se resuelve vía aiModelRepo.findByCategoryId(), que ya
// hace exactamente el mismo filtro (category_id + is_active=1) con SELECT *.

const aiModelRepo = require('../repositories/aiModelRepo');

const ENDPOINT = () => process.env.CV_PREDICTION_ENDPOINT;
const KEY = () => process.env.CV_PREDICTION_KEY;

// Timeout de la llamada a Azure. El gerente está esperando en la tienda: si Azure no
// responde en este tiempo, es mejor devolver error que dejar la app colgada.
const TIMEOUT_MS = parseInt(process.env.CV_PREDICTION_TIMEOUT_MS || '20000', 10);

/**
 * Valida que el modelo esté en condiciones de recibir predicciones.
 * Lanza un error descriptivo si no lo está — es preferible fallar acá con un mensaje
 * claro que mandar la llamada a Azure y recibir un error genérico.
 */
function validarModelo(modelo, categoryId) {
  if (!modelo) {
    const err = new Error(`No hay modelo activo para category_id=${categoryId}`);
    err.code = 'NO_MODEL';
    throw err;
  }
  if (modelo.status !== 'PUBLISHED') {
    const err = new Error(
      `El modelo de category_id=${categoryId} está en status='${modelo.status}', no 'PUBLISHED'`
    );
    err.code = 'MODEL_NOT_PUBLISHED';
    err.status = modelo.status;
    throw err;
  }
  if (!modelo.last_publish_name) {
    const err = new Error(
      `El modelo de category_id=${categoryId} no tiene last_publish_name`
    );
    err.code = 'NO_PUBLISH_NAME';
    throw err;
  }
  if (!modelo.customvision_project_id) {
    const err = new Error(
      `El modelo de category_id=${categoryId} no tiene customvision_project_id`
    );
    err.code = 'NO_PROJECT_ID';
    throw err;
  }
}

/**
 * Construye la URL de la llamada de predicción.
 *
 *   {endpoint}/customvision/v3.0/Prediction/{projectId}/detect/iterations/{publishName}/image
 *
 * El publishName va codificado por si contiene caracteres especiales.
 */
function construirUrl(projectId, publishName) {
  const base = ENDPOINT().replace(/\/+$/, '');   // quitar barra final si la tiene
  return `${base}/customvision/v3.0/Prediction/${projectId}` +
         `/detect/iterations/${encodeURIComponent(publishName)}/image`;
}

/**
 * Llama a Custom Vision Predict con los bytes de la imagen.
 * Devuelve el arreglo crudo de predictions, sin filtrar.
 */
async function llamarPredict(url, imagenBuffer) {
  if (!ENDPOINT() || !KEY()) {
    const err = new Error(
      'Faltan CV_PREDICTION_ENDPOINT o CV_PREDICTION_KEY en las variables de entorno'
    );
    err.code = 'MISSING_CREDENTIALS';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let respuesta;
  try {
    respuesta = await fetch(url, {
      method: 'POST',
      headers: {
        'Prediction-Key': KEY(),
        'Content-Type': 'application/octet-stream',
      },
      body: imagenBuffer,
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`Custom Vision no respondió en ${TIMEOUT_MS} ms`);
      err.code = 'PREDICT_TIMEOUT';
      throw err;
    }
    const err = new Error(`Error de red llamando a Custom Vision: ${e.message}`);
    err.code = 'PREDICT_NETWORK';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Azure devuelve JSON tanto en éxito como en error. Hay que revisar el status
  // ANTES de intentar leer 'predictions'.
  if (!respuesta.ok) {
    const cuerpo = await respuesta.text();
    const err = new Error(`Custom Vision ${respuesta.status}: ${cuerpo}`);
    err.code = 'PREDICT_FAILED';
    err.httpStatus = respuesta.status;
    err.azureBody = cuerpo;   // se devuelve tal cual, sin envolverlo
    throw err;
  }

  const data = await respuesta.json();

  // Si no detectó nada, 'predictions' puede venir vacío. Eso es un resultado válido,
  // no un error: puede ser una limitación del modelo, no un problema de la foto.
  if (!Array.isArray(data.predictions)) {
    const err = new Error('La respuesta de Custom Vision no trae el arreglo predictions');
    err.code = 'PREDICT_BAD_RESPONSE';
    err.azureBody = JSON.stringify(data);
    throw err;
  }

  return data.predictions;
}

/**
 * Filtra por umbral de confianza y mapea al formato de RETSC_EX_SHELFPHOTO_DETECTION.
 *
 * NOTA sobre 'tagName': Custom Vision devuelve el tag (hoy el canal, ej. 'OMT'), pero el
 * pipeline de visita lo ignora deliberadamente. La categoría sale de
 * RETSC_EX_SHELFPHOTO.CATEGORY_ID y el canal se deriva del Retailer_id. Así el pipeline
 * no depende de cómo esté configurado el tag en Custom Vision, que es un tema abierto.
 *
 * NOTA sobre el umbral: confidence_threshold es decimal(5,2). Puede estar guardado como
 * fracción (0.50) o como porcentaje (50.00). Custom Vision devuelve probability como
 * fracción de 0 a 1, así que hay que normalizar antes de comparar.
 */
function normalizarUmbral(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return 0.5;   // fallback defensivo
  return n > 1 ? n / 100 : n;
}

function filtrarYMapear(predictions, umbralCrudo, photoId, detectionModelId) {
  const umbral = normalizarUmbral(umbralCrudo);

  return predictions
    .filter(p => p.probability >= umbral)
    .map(p => ({
      photo_id:           photoId,
      confidence:         p.probability,
      bbox_left:          p.boundingBox.left,
      bbox_top:           p.boundingBox.top,
      bbox_width:         p.boundingBox.width,
      bbox_height:        p.boundingBox.height,
      detection_model_id: detectionModelId,
    }));
}

// Reintentos para fallos TRANSITORIOS de la llamada a Custom Vision (timeout, error de red,
// 5xx del lado de Azure) — esto es justo lo que causó el bug real de "0 detecciones sin
// ningún error visible" (Photo_id=33, 2026-09-24): el pipeline corre fire-and-forget después
// de responder el 201 al mobile, así que un solo hipo de red se traducía en "no encontró
// nada", indistinguible de un resultado legítimo. NO se reintenta en errores definitivos
// (credenciales faltantes, modelo no publicado, 4xx) — esos no se arreglan solos.
const RETRYABLE_CODES = new Set(['PREDICT_TIMEOUT', 'PREDICT_NETWORK']);
const MAX_ATTEMPTS = parseInt(process.env.CV_PREDICTION_MAX_ATTEMPTS || '3', 10);

function esReintentable(err) {
  if (RETRYABLE_CODES.has(err.code)) return true;
  return err.code === 'PREDICT_FAILED' && err.httpStatus >= 500 && err.httpStatus < 600;
}

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function llamarPredictConReintento(url, imagenBuffer) {
  let ultimoError;
  for (let intento = 1; intento <= MAX_ATTEMPTS; intento++) {
    try {
      const predictions = await llamarPredict(url, imagenBuffer);
      if (intento > 1) {
        console.log(`[customVisionPredict] éxito en el intento ${intento}/${MAX_ATTEMPTS} tras reintentar.`);
      }
      return { predictions, intentos: intento };
    } catch (err) {
      ultimoError = err;
      if (!esReintentable(err) || intento === MAX_ATTEMPTS) throw Object.assign(err, { intentos: intento });
      console.warn(
        `[customVisionPredict] intento ${intento}/${MAX_ATTEMPTS} falló (${err.code}): ${err.message} — reintentando...`
      );
      await sleep(1000 * intento);   // backoff lineal: 1s, 2s, ...
    }
  }
  throw ultimoError;
}

/**
 * Punto de entrada del servicio.
 *
 * @param {Buffer} imagenBuffer  bytes de la foto
 * @param {number} categoryId    categoría de la foto
 * @param {number} photoId       Photo_id ya generado por la BD (IDENTITY)
 *
 * @returns {{ detecciones: Array, totalDevueltas: number, umbralAplicado: number,
 *             detectionModelId: number, iteracion: string }}
 */
async function predecirFoto(imagenBuffer, categoryId, photoId) {
  if (!imagenBuffer || imagenBuffer.length === 0) {
    const err = new Error('El buffer de la imagen está vacío');
    err.code = 'EMPTY_IMAGE';
    throw err;
  }

  // Chequeado ACÁ (antes de construirUrl) y no solo dentro de llamarPredict: construirUrl
  // llama a ENDPOINT().replace(...) sin guardas — si CV_PREDICTION_ENDPOINT falta, revienta
  // con un TypeError crudo ("Cannot read properties of undefined") en vez del
  // MISSING_CREDENTIALS descriptivo que se busca (ver sección 5 de la spec: nunca un error
  // genérico confuso). Confirmado con una llamada real sin credenciales configuradas.
  if (!ENDPOINT() || !KEY()) {
    const err = new Error(
      'Faltan CV_PREDICTION_ENDPOINT o CV_PREDICTION_KEY en las variables de entorno'
    );
    err.code = 'MISSING_CREDENTIALS';
    throw err;
  }

  const modelo = await aiModelRepo.findByCategoryId(categoryId);
  validarModelo(modelo, categoryId);

  const url = construirUrl(modelo.customvision_project_id, modelo.last_publish_name);
  const { predictions, intentos } = await llamarPredictConReintento(url, imagenBuffer);

  const detecciones = filtrarYMapear(
    predictions,
    modelo.confidence_threshold,
    photoId,
    modelo.detection_model_id
  );

  return {
    detecciones,
    totalDevueltas:   predictions.length,     // antes de filtrar
    umbralAplicado:   normalizarUmbral(modelo.confidence_threshold),
    detectionModelId: modelo.detection_model_id,
    iteracion:        modelo.last_publish_name,
    intentos,
  };
}

module.exports = {
  predecirFoto,
  validarModelo,
  construirUrl,
  filtrarYMapear,
  normalizarUmbral,
};
