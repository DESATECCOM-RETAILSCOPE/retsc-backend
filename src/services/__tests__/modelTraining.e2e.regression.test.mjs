// Verificación end-to-end (con stubs) de que el disparo automático (spec v1.4) encadena SOLO,
// sin intervención manual, hasta PUBLISHED — y de que el fix de tags vacíos (2026-08-09) evita
// que Custom Vision tumbe el training entero por un tag huérfano con 0 imágenes.
//
// Por qué con stubs y no contra CV/BD reales: el ambiente real (sqldb-rscope-prod) NO tiene hoy
// un modelo en condiciones de disparar el umbral de forma segura (category_id=2 sigue en
// PROJECT_CREATED, 0 tags reales en su proyecto CV — ver diagnóstico previo a este fix), y las
// reglas de esta tarea prohíben tanto editar estado a mano como arriesgar un modelo ya
// publicado. Este test reproduce el escenario real (un tag huérfano de un intento anterior)
// contra un doble en memoria de customVisionService/aiModelRepo, mismo patrón que
// annotationSync.regression.test.mjs.
//
// Correr: node src/services/__tests__/modelTraining.e2e.regression.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SVC_DIR = path.join(process.cwd(), 'src', 'services');
const REPO_DIR = path.join(process.cwd(), 'src', 'repositories');
const absSvc  = (p) => require.resolve(path.join(SVC_DIR, p));
const absRepo = (p) => require.resolve(path.join(REPO_DIR, p));

function stub(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

function loadServiceFresh() {
  delete require.cache[absSvc('./modelTrainingService')];
  return require(absSvc('./modelTrainingService'));
}

test('tag huérfano (0 imágenes) es purgado antes de entrenar — trainProject ya no lo rechaza', async () => {
  const cvState = {
    tags: [
      { id: 'tag-omt', name: 'OMT', imageCount: 15 },   // canal sano, con imágenes reales
      { id: 'tag-dtt', name: 'DTT', imageCount: 0 },     // huérfano — residuo de un intento anterior
    ],
    deletedTagIds: [],
    trainProjectCalls: 0,
  };

  stub(absSvc('./customVisionService'), {
    isConfigured: () => true,
    listTags: async () => cvState.tags,
    deleteTag: async (_projectId, tagId) => {
      cvState.deletedTagIds.push(tagId);
      cvState.tags = cvState.tags.filter(t => t.id !== tagId);
    },
    trainProject: async () => {
      cvState.trainProjectCalls++;
      const empty = cvState.tags.filter(t => (t.imageCount ?? 0) === 0);
      if (empty.length) {
        throw new Error('400 BadRequestDetectionTrainingValidationFailed: "Not enough images per tag for training"');
      }
      return { id: 'iter-1', status: 'New' };
    },
    // 'Completed' inmediato — no nos interesa el loop de polling en este test (ese es el
    // segundo test), solo que trainProject() no sea rechazado. Si esto quedara en 'New',
    // el poll fire-and-forget que startTraining() dispara internamente reintentaría cada 30s
    // hasta 40 veces (20 min) y mantendría el proceso de test vivo de fondo sin que nada lo
    // esperara — justo lo que pasó en el primer intento de correr este archivo.
    getIteration: async () => ({ status: 'Completed' }),
    getIterationPerformance: async () => ({ precision: 0.9, recall: 0.85, averagePrecision: 0.88 }),
    publishIteration: async () => true,
  });

  const calls = { updateStatus: [], markTrainingFailed: [] };
  stub(absRepo('aiModelRepo'), {
    findByCategoryId: async () => ({
      detection_model_id: 1, category_id: 2, customvision_project_id: 'proj-1',
      status: 'IMAGES_UPLOADED', prediction_resource_id: 'res-1', trained_at: null,
    }),
    updateStatus: async (id, status) => { calls.updateStatus.push({ id, status }); },
    markTrainingFailed: async (id, msg) => { calls.markTrainingFailed.push({ id, msg }); },
    findById: async () => null,
    markTrained: async () => {},
    saveMetrics: async () => {},
    getMaxVersion: async () => 1,
    markPublished: async () => {},
    setActiveVersion: async () => {},
  });

  const modelTrainingService = loadServiceFresh();
  const result = await modelTrainingService.startTraining(2, null);

  assert.equal(cvState.deletedTagIds.length, 1, 'debe haber borrado exactamente el tag huérfano');
  assert.equal(cvState.deletedTagIds[0], 'tag-dtt');
  assert.equal(cvState.tags.length, 1, 'solo debe quedar el tag sano (OMT)');
  assert.equal(cvState.trainProjectCalls, 1, 'trainProject se llamó una sola vez y NO fue rechazado');
  assert.equal(result.status, 'TRAINING');
  assert.equal(calls.markTrainingFailed.length, 0, 'no debe haber ningún rechazo registrado — el tag ya estaba limpio al llamar a trainProject');
  assert.ok(calls.updateStatus.some(c => c.status === 'TRAINING'), 'debe marcar el modelo en TRAINING');
});

test('cadena automática completa: umbral → train → poll → publish → PUBLISHED, sin pasos manuales', async () => {
  const model = {
    detection_model_id: 5, category_id: 2, customvision_project_id: 'proj-2',
    status: 'IMAGES_UPLOADED', prediction_resource_id: 'res-2', trained_at: null,
    model_version: 1, is_active: 1,
  };

  const calls = { markTrained: [], updateStatus: [], markPublished: [], setActiveVersion: [], setTrainingError: [] };

  stub(absSvc('./customVisionService'), {
    isConfigured: () => true,
    listTags: async () => [{ id: 'tag-omt', name: 'OMT', imageCount: 15 }], // ya limpio, sin huérfanos
    deleteTag: async () => {},
    trainProject: async () => ({ id: 'iter-9', status: 'New' }),
    // Completed en el primer intento — no nos interesa probar el loop de polling en sí (ya
    // cubierto por el código preexistente), solo que la CADENA hasta PUBLISHED se ejecuta sola.
    getIteration: async () => ({ status: 'Completed' }),
    getIterationPerformance: async () => ({ precision: 0.9, recall: 0.85, averagePrecision: 0.88 }),
    publishIteration: async () => true,
  });

  stub(absRepo('aiModelRepo'), {
    findByCategoryId: async () => model,
    findById: async (id) => (id === model.detection_model_id ? model : null),
    updateStatus: async (id, status) => { calls.updateStatus.push({ id, status }); model.status = status; },
    markTrainingFailed: async () => {},
    setTrainingError: async (id, msg) => { calls.setTrainingError.push({ id, msg }); },
    markTrained: async (id) => { calls.markTrained.push(id); model.trained_at = '2026-08-09'; },
    saveMetrics: async () => {},
    getMaxVersion: async () => 1,
    markPublished: async (id, { modelVersion, lastPublishName }) => {
      calls.markPublished.push({ id, modelVersion, lastPublishName });
      model.model_version = modelVersion;
      model.last_publish_name = lastPublishName;
    },
    setActiveVersion: async (categoryId, modelId) => {
      calls.setActiveVersion.push({ categoryId, modelId });
      model.status = 'PUBLISHED';
      model.is_active = 1;
    },
  });

  const modelTrainingService = loadServiceFresh();

  // startTraining() es lo que checkAndUpdateThreshold llama automáticamente al detectar el
  // umbral — nada de lo que sigue es manual, es la misma cadena fire-and-forget del código real.
  const started = await modelTrainingService.startTraining(2, null);
  assert.equal(started.status, 'TRAINING');

  // La cadena train→poll→publish corre en background dentro del mismo módulo (fire-and-forget
  // real de startTraining). La esperamos explícitamente acá vía el mismo pollTrainingStatus
  // exportado, con el iterationId que startTraining ya disparó — no se salta ningún paso del
  // código real, solo se espera de forma determinística en vez de vía background+timers.
  await modelTrainingService.pollTrainingStatus(model.detection_model_id, model.customvision_project_id, started.iterationId);

  assert.ok(calls.markTrained.length >= 1, 'debe avanzar trained_at al completar el training');
  assert.ok(calls.updateStatus.some(c => c.status === 'TRAINED'), 'debe pasar por TRAINED');
  assert.ok(calls.markPublished.length >= 1, 'debe llamar a markPublished tras publicar en Custom Vision');
  assert.ok(calls.setActiveVersion.length >= 1, 'debe llamar a setActiveVersion — el paso que realmente marca PUBLISHED');
  assert.equal(calls.setTrainingError.length, 0, 'la publicación no debe haber fallado');
  assert.equal(model.status, 'PUBLISHED', 'el modelo debe terminar en PUBLISHED sin ningún paso manual');
});
