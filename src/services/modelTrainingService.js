// Issue 8.3/8.4 — Entrenamiento y publicación automática del modelo de detección de góndola
// por categoría (cableado completo del flujo automático de la spec v1.4, 2026-08-03).
//
// RETIRADO 2026-08-03 (decisión de jefatura): el endpoint manual — POST /api/training/models/
// :categoryId/train, trainingRoutes.js/trainingController.js — fue eliminado por completo (no
// queda puerta manual ni para pruebas). El único caller de `startTraining()` hoy es
// `annotationSyncService.checkAndUpdateThreshold()`, que lo llama automáticamente al detectar
// ≥`SHELF_TRAINING_THRESHOLD` fotos SYNCED (por primera vez, o acumuladas desde el último
// entrenamiento) para una categoría+canal — ver ese archivo y
// docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md. `adminUserId` puede venir `null` cuando el disparo
// es automático (no hay un admin detrás) — el log de abajo lo contempla.
//
// Solo se puede iniciar si el modelo está en IMAGES_UPLOADED (guardia de estado) —
// `checkAndUpdateThreshold` ya marca ese estado antes de llamar a esta función.
//
// FIRE-AND-FORGET: startTraining() dispara el entrenamiento en Custom Vision y responde de
// inmediato — el polling de estado (pollTrainingStatus) corre en background dentro del mismo
// proceso Node, sin bloquear al caller (antes la respuesta HTTP del endpoint retirado; ahora
// el sync de `annotationSyncService`). El progreso se consulta con
// GET /api/models/category/:categoryId (Issue 8.5) — devuelve el `status` actual del modelo
// (TRAINING → TRAINED → PUBLISHED | TRAINING_FAILED).
//
// LIMITACIÓN CONOCIDA: el polling vive en memoria del proceso Node. Si el server se reinicia
// a mitad de un entrenamiento, el polling se pierde y el modelo queda "colgado" en TRAINING
// (Custom Vision sigue entrenando del lado de Azure, pero nadie lo vuelve a consultar).
// TODO: idealmente, al arrancar el server debería revisarse si hay modelos en TRAINING y
// reanudar su polling (similar a `jobRepo.failStaleRunning` en app.js, pero resumiendo en vez
// de fallar). Fuera de alcance de este cableado — por ahora, la única mitigación es esperar a
// que se acumulen más fotos y se dispare un nuevo intento, o reiniciar manualmente vía script.
//
// DECISIÓN — métricas por debajo del mínimo: NUNCA bloquean nada (alineado con la spec v1.4 —
// las métricas son solo monitoreo). El estado pasa a TRAINED igual, con las métricas bajas
// logueadas y guardadas (saveMetrics, sin gate) para referencia futura. La publicación
// automática (ver publishAndActivate() abajo) tampoco las consulta.
//
// DECISIÓN — sin columna dedicada para iterationId: RETSC_AI_DETECTION_MODELS no tiene una
// columna `iteration_id` (no se agrega estructura sin aviso). La idea es guardarlo dentro de
// `metrics_json` junto con el payload crudo de performance, reusando aiModelRepo.saveMetrics().
//
// ⚠ VERIFICADO CON INFORMATION_SCHEMA (2026-07-12, re-flagged 2026-08-03): la migración 006
// (precision_score/recall_score/mean_ap/metrics_json — approved_by/approved_at se quitaron
// del script el 2026-08-03, ver migrations/006_*.sql) NO está aplicada en esta base — esas
// columnas no existen todavía. Confirmado en pruebas reales: aiModelRepo.saveMetrics() lanza
// "Invalid column name 'metrics_json'". handleTrainingCompleted() envuelve ese llamado en
// try/catch para que un fallo de guardado de métricas NUNCA impida pasar a TRAINED ni bloquee
// la publicación — mientras tanto quedan logueadas. Por esta misma razón, avanzar `trained_at`
// (necesario para que el conteo "+15 desde el último entrenamiento" de
// `annotationSyncService` funcione) NO depende de que `saveMetrics()` tenga éxito — ver
// `aiModelRepo.markTrained()`, llamado siempre, independientemente de la migración 006. Una
// vez se corra esa migración (fuera de alcance de este cableado — no se corre sin aviso), el
// guardado de métricas empieza a funcionar sin tocar este código.
//
// ⚠ BLOQUEANTES CONOCIDOS DE AZURE para que la publicación (Custom Vision `publishIteration`)
// funcione de punta a punta — NINGUNO de código, ambos gestionados por fuera de este repo:
//   1. `prediction_resource_id` se guarda NULL si el Resource ID de ARM real excede el
//      VARCHAR(100) de la columna (ver aiInfrastructureService.js, BUG documentado 2026-07-19).
//   2. Aun con un id sintácticamente válido, el Resource ID actual de `.env` devolvió
//      `BadRequestInvalidPublishTarget` contra Custom Vision real (probado 2026-08-03) —
//      probablemente no es el recurso de PREDICCIÓN correcto (podría ser el de training). Se
//      está gestionando el Resource ID correcto por fuera de este repo.
// `publishAndActivate()` maneja ambos casos sin romper el flujo: si falla, el modelo queda en
// TRAINED (entrenado pero sin publicar) y se loguea la razón — nunca lanza, nunca tira abajo
// el polling ni el resto del ciclo. Cuando el Resource ID correcto esté configurado, la
// publicación funcionará sin cambios de código acá.

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

  const trigger = adminUserId ? `adminUserId=${adminUserId}` : 'disparo automático (umbral spec v1.4)';
  console.log(`[modelTraining] entrenamiento iniciado por ${trigger} — categoria=${categoryId} model_id=${model.detection_model_id} iterationId=${iteration.id}`);

  // Fire-and-forget: no se hace await de esto — el caller (antes el endpoint retirado, ahora
  // annotationSyncService.checkAndUpdateThreshold) ya siguió su curso.
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

// La iteración terminó con status='Completed': trae métricas (monitoreo, sin gate), las
// guarda, marca TRAINED, y dispara la publicación automática (spec v1.4, 4.4).
async function handleTrainingCompleted(modelId, projectId, iterationId) {
  const model = await aiModelRepo.findById(modelId);
  if (!model) {
    console.error(`[modelTraining] handleTrainingCompleted: no se encontró el modelo ${modelId} — no se puede continuar`);
    return;
  }

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
      console.warn(`[modelTraining] métricas por debajo del mínimo recomendado (precision=${precision}, recall=${recall}, mAP=${averagePrecision}) — model_id=${modelId}. Solo monitoreo (spec v1.4): NO bloquea el paso a TRAINED ni la publicación automática.`);
    } else {
      console.log(`[modelTraining] métricas OK (precision=${precision}, recall=${recall}, mAP=${averagePrecision}) — model_id=${modelId}`);
    }

    // TEMPORAL — ver NOTA de cabecera: migración 006 (precision_score/recall_score/mean_ap/
    // metrics_json) NO está aplicada en esta BD (confirmado con INFORMATION_SCHEMA, 2026-07-12);
    // aiModelRepo.saveMetrics() lanza "Invalid column name" hasta que se corra esa migración.
    // Nunca debe bloquear el paso a TRAINED ni la publicación — el training SÍ terminó aunque
    // no se puedan persistir las métricas todavía. Quedan logueadas para no perderlas del todo
    // mientras tanto. `markTrained()` (abajo) avanza `trained_at` de forma independiente de
    // este try/catch — ver NOTA de cabecera sobre por qué eso es necesario para el umbral.
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

  // markTrained() SIEMPRE corre, tenga o no éxito saveMetrics() — ver NOTA de cabecera del
  // archivo (aiModelRepo.markTrained) sobre por qué esto no puede depender de la migración 006.
  await aiModelRepo.markTrained(modelId)
    .catch(err => console.error(`[modelTraining] no se pudo avanzar trained_at (model_id=${modelId}):`, err.message));
  await aiModelRepo.updateStatus(modelId, 'TRAINED');

  await publishAndActivate(model, projectId, iterationId);
}

// Publicación automática (spec v1.4, 4.4) — SIN aprobación humana, SIN gate de métricas (ambos
// retirados por decisión de jefatura, ver docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md). Nunca
// lanza: si Custom Vision rechaza la publicación (ver BLOQUEANTES DE AZURE en la cabecera del
// archivo — Resource ID null o inválido), el modelo queda en TRAINED (entrenado, no publicado)
// y se loguea la razón con claridad. No hay reintento inmediato separado — el próximo ciclo de
// entrenamiento (cuando se acumulen +15 fotos más para esta categoría) vuelve a intentarlo con
// el mismo mecanismo, sin cambios de código, en cuanto el Resource ID de predicción correcto
// esté configurado.
async function publishAndActivate(model, projectId, iterationId) {
  const { detection_model_id: modelId, category_id: categoryId, prediction_resource_id: predictionResourceId } = model;

  const nextVersion = (await aiModelRepo.getMaxVersion(categoryId)) + 1;
  // Nombre único por versión + fecha (spec v1.4: "incluir fecha o versión para evitar
  // colisión") — overwrite:true además cubre el caso de un reintento el mismo día que recalcule
  // la misma versión (p. ej. si un intento anterior falló antes de que markPublished() persistiera
  // el incremento de model_version).
  const publishName = `v${nextVersion}-${new Date().toISOString().slice(0, 10)}`;

  try {
    await customVisionService.publishIteration(projectId, iterationId, publishName, predictionResourceId, { overwrite: true });
  } catch (err) {
    console.warn(`[modelTraining] publicación automática PENDIENTE de configuración de Azure — categoria=${categoryId} model_id=${modelId} iterationId=${iterationId}: ${err.message}. El modelo queda en TRAINED (entrenado, no publicado); se reintentará en el próximo ciclo de entrenamiento sin cambios de código una vez el Resource ID de predicción esté configurado correctamente.`);
    return;
  }

  await aiModelRepo.markPublished(modelId, { modelVersion: nextVersion, lastPublishName: publishName });
  await aiModelRepo.setActiveVersion(categoryId, modelId);
  console.log(`[modelTraining] iteración publicada y activada — categoria=${categoryId} model_id=${modelId} version=${nextVersion} publishName=${publishName}`);
}

module.exports = { startTraining, pollTrainingStatus };
