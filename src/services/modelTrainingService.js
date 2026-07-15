// Issue 8.3 — Entrenamiento asíncrono del modelo de detección de góndola por categoría.
//
// Un admin DTC lo dispara manualmente desde el Web Admin (POST /api/training/models/:categoryId/train).
// Solo se puede iniciar si el modelo está en IMAGES_UPLOADED (guardia de estado).
//
// FIRE-AND-FORGET: startTraining() dispara el entrenamiento en Custom Vision y responde de
// inmediato — el polling de estado (pollTrainingStatus) corre en background dentro del mismo
// proceso Node, sin bloquear la respuesta HTTP. El progreso se consulta con
// GET /api/models/category/:categoryId (ya existe, Issue 8.5) — devuelve el `status` actual
// del modelo (TRAINING → TRAINED | TRAINING_FAILED).
//
// LIMITACIÓN CONOCIDA: el polling vive en memoria del proceso Node. Si el server se reinicia
// a mitad de un entrenamiento, el polling se pierde y el modelo queda "colgado" en TRAINING
// (Custom Vision sigue entrenando del lado de Azure, pero nadie lo vuelve a consultar).
// TODO: idealmente, al arrancar el server debería revisarse si hay modelos en TRAINING y
// reanudar su polling (similar a `jobRepo.failStaleRunning` en app.js, pero resumiendo en vez
// de fallar). Fuera de alcance de este issue — por ahora, la única mitigación es reintentar
// manualmente el entrenamiento o construir un endpoint de "reconsultar estado" a demanda.
//
// DECISIÓN — métricas por debajo del mínimo: el estado pasa a TRAINED igual, con las métricas
// bajas logueadas (y guardadas) para que el admin decida. TRAINED significa "Custom Vision
// terminó de entrenar", no "cumple el mínimo de calidad" — esa evaluación es responsabilidad
// del admin (o del futuro flujo de publicación, 8.4), no de este servicio. No se agrega un
// estado TRAINED_BELOW_THRESHOLD sin confirmar con el equipo.
//
// DECISIÓN — sin columna dedicada para iterationId: RETSC_AI_DETECTION_MODELS no tiene una
// columna `iteration_id` (no se agrega estructura sin aviso). La idea es guardarlo dentro de
// `metrics_json` junto con el payload crudo de performance, reusando aiModelRepo.saveMetrics().
//
// ⚠ VERIFICADO CON INFORMATION_SCHEMA (2026-07-12): la migración 006
// (precision_score/recall_score/mean_ap/metrics_json/approved_by/approved_at) NO está aplicada
// en esta base — esas columnas no existen todavía, pese a que el código de `aiModelRepo.js`
// (Issue 8.5) ya asume que sí. Confirmado en pruebas reales: aiModelRepo.saveMetrics() lanza
// "Invalid column name 'metrics_json'". handleTrainingCompleted() envuelve ese llamado en
// try/catch para que un fallo de guardado de métricas NUNCA impida pasar a TRAINED (el training
// sí terminó del lado de Custom Vision aunque no se puedan persistir las métricas todavía) —
// mientras tanto quedan logueadas. Una vez se corra la migración 006 (fuera de alcance de este
// issue — no se corre sin aviso), el guardado empieza a funcionar sin tocar este código.

const aiModelRepo         = require('../repositories/aiModelRepo');
const customVisionService = require('./customVisionService');

const POLL_INTERVAL_MS            = 30_000;      // 30s entre consultas a Custom Vision
const MAX_POLL_ATTEMPTS           = 40;          // 40 * 30s = 20 min — timeout de seguridad
const MAX_CONSECUTIVE_FETCH_ERRORS = 3;          // reintentos ante fallos de red/API antes de rendirse

// Mínimos recomendados (solo para loguear/guardar — no bloquean el paso a TRAINED).
const MIN_PRECISION = 0.80;
const MIN_RECALL    = 0.75;
const MIN_MAP        = 0.75;

function svcError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Llamado por el endpoint. NO espera a que el entrenamiento termine — dispara trainProject,
// marca TRAINING, lanza el polling en background (sin await) y devuelve de inmediato.
async function startTraining(categoryId, adminUserId) {
  const model = await aiModelRepo.findByCategoryId(categoryId);
  if (!model) {
    throw svcError(`No hay un modelo activo para la categoría ${categoryId}.`, 404);
  }
  if (model.status !== 'IMAGES_UPLOADED') {
    throw svcError(
      `El modelo debe estar en estado IMAGES_UPLOADED para iniciar entrenamiento; está en ${model.status}.`,
      409
    );
  }
  if (!model.customvision_project_id) {
    throw svcError(`El modelo de la categoría ${categoryId} no tiene un proyecto de Custom Vision asociado.`, 409);
  }

  const iteration = await customVisionService.trainProject(model.customvision_project_id);
  await aiModelRepo.updateStatus(model.detection_model_id, 'TRAINING');

  console.log(`[modelTraining] entrenamiento iniciado por adminUserId=${adminUserId} — categoria=${categoryId} model_id=${model.detection_model_id} iterationId=${iteration.id}`);

  // Fire-and-forget: no se hace await de esto — el endpoint ya respondió 202.
  pollTrainingStatus(model.detection_model_id, model.customvision_project_id, iteration.id)
    .catch(err => console.error(`[modelTraining] el polling de fondo terminó con un error inesperado (model_id=${model.detection_model_id}):`, err.message));

  return { status: 'TRAINING', iterationId: iteration.id, modelId: model.detection_model_id };
}

// Corre en background (no lo llama el endpoint directamente). Consulta Custom Vision cada
// POLL_INTERVAL_MS hasta que la iteración termine (Completed/Failed), falle repetidamente al
// consultar, o se agote MAX_POLL_ATTEMPTS (timeout de seguridad — nunca hace polling infinito).
async function pollTrainingStatus(modelId, projectId, iterationId) {
  let consecutiveErrors = 0;

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    let iteration;
    try {
      iteration = await customVisionService.getIteration(projectId, iterationId);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.warn(`[modelTraining] fallo consultando iteración (intento ${attempt}/${MAX_POLL_ATTEMPTS}, error consecutivo ${consecutiveErrors}/${MAX_CONSECUTIVE_FETCH_ERRORS}, model_id=${modelId}):`, err.message);
      if (consecutiveErrors >= MAX_CONSECUTIVE_FETCH_ERRORS) {
        console.error(`[modelTraining] demasiados fallos consecutivos consultando Custom Vision — marcando TRAINING_FAILED (model_id=${modelId})`);
        await aiModelRepo.updateStatus(modelId, 'TRAINING_FAILED')
          .catch(e2 => console.error('[modelTraining] no se pudo marcar TRAINING_FAILED:', e2.message));
        return;
      }
      continue;
    }

    if (iteration.status === 'Completed') {
      console.log(`[modelTraining] entrenamiento completado — model_id=${modelId} iterationId=${iterationId}`);
      await handleTrainingCompleted(modelId, projectId, iterationId);
      return;
    }

    if (iteration.status === 'Failed') {
      console.error(`[modelTraining] Custom Vision reportó Failed — model_id=${modelId} iterationId=${iterationId}`);
      await aiModelRepo.updateStatus(modelId, 'TRAINING_FAILED')
        .catch(e2 => console.error('[modelTraining] no se pudo marcar TRAINING_FAILED:', e2.message));
      return;
    }

    // status 'New' o 'Training' → seguir esperando la próxima vuelta del loop.
  }

  console.error(`[modelTraining] timeout de seguridad (${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60000} min) esperando a Custom Vision — model_id=${modelId} iterationId=${iterationId}`);
  await aiModelRepo.updateStatus(modelId, 'TRAINING_FAILED')
    .catch(e2 => console.error('[modelTraining] no se pudo marcar TRAINING_FAILED tras timeout:', e2.message));
}

// La iteración terminó con status='Completed': trae métricas, las loguea/guarda, y marca TRAINED.
async function handleTrainingCompleted(modelId, projectId, iterationId) {
  let performance = null;
  try {
    performance = await customVisionService.getIterationPerformance(projectId, iterationId);
  } catch (err) {
    console.error(`[modelTraining] no se pudieron obtener métricas de rendimiento (model_id=${modelId}):`, err.message);
  }

  if (performance) {
    const { precision, recall, averagePrecision } = performance;
    const belowMinimums = precision < MIN_PRECISION || recall < MIN_RECALL || averagePrecision < MIN_MAP;

    if (belowMinimums) {
      console.warn(`[modelTraining] métricas por debajo del mínimo recomendado (precision=${precision}, recall=${recall}, mAP=${averagePrecision}) — model_id=${modelId}. El entrenamiento terminó igual; queda en TRAINED para revisión del admin.`);
    } else {
      console.log(`[modelTraining] métricas OK (precision=${precision}, recall=${recall}, mAP=${averagePrecision}) — model_id=${modelId}`);
    }

    // TEMPORAL — ver NOTA de cabecera: migración 006 (precision_score/recall_score/mean_ap/
    // metrics_json) NO está aplicada en esta BD (confirmado con INFORMATION_SCHEMA, 2026-07-12);
    // aiModelRepo.saveMetrics() lanza "Invalid column name" hasta que se corra esa migración.
    // Nunca debe bloquear el paso a TRAINED — el training SÍ terminó aunque no se puedan
    // persistir las métricas todavía. Quedan logueadas para no perderlas del todo mientras tanto.
    try {
      await aiModelRepo.saveMetrics(modelId, {
        precisionScore: precision,
        recallScore:    recall,
        meanAp:         averagePrecision,
        metricsJson:    JSON.stringify({ iterationId, ...performance }),
      });
    } catch (err) {
      console.error(`[modelTraining] no se pudieron guardar las métricas en BD (¿falta correr la migración 006?) — model_id=${modelId}:`, err.message);
      console.warn(`[modelTraining] métricas sin persistir — iterationId=${iterationId} precision=${precision} recall=${recall} mAP=${averagePrecision}`);
    }
  }

  await aiModelRepo.updateStatus(modelId, 'TRAINED');
}

module.exports = { startTraining, pollTrainingStatus };
