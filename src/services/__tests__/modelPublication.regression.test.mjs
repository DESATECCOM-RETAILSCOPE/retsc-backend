// Ciclo 5 (A4) — datos de la publicación en RETSC_AI_DETECTION_MODELS, errores y recuperación.
//   · prediction_resource_id SIEMPRE del .env al publicar (validado), nunca de la fila
//   · versión +1, nombre v{n}-{yyyy-MM-dd}, activación, fila actualizada con el Resource ID usado
//   · publicación fallida/no intentada → queda TRAINED con motivo (setTrainingError)
//   · recuperación al arrancar: TRAINING se retoma/completa/falla; IMAGES_UPLOADED → TRAINING_FAILED
// Sin BD ni Azure. Correr: node src/services/__tests__/modelPublication.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SVC  = (p) => require.resolve(path.join(process.cwd(), 'src', 'services', p));
const REPO = (p) => require.resolve(path.join(process.cwd(), 'src', 'repositories', p));
const stub = (abs, exports) => { require.cache[abs] = { id: abs, filename: abs, loaded: true, exports }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const VALID = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/cvrscopeaiprod-Prediction';
process.env.CV_POLL_INTERVAL_MS = '5';

function load({ cv = {}, repo = {} } = {}) {
  const calls = { publish: [], setTrainingError: [], markPublished: [], setActiveVersion: [], updateRes: [],
                  markTrainingFailed: [], getIteration: [], markTrained: [] };
  stub(SVC('customVisionService.js'), {
    isConfigured: () => true,
    publishIteration: async (projectId, iterationId, name, resId) => { calls.publish.push({ projectId, iterationId, name, resId }); return true; },
    getIteration: async (projectId, iterationId) => { calls.getIteration.push(iterationId); return { status: 'Completed' }; },
    getIterationPerformance: async () => ({ precision: 0.9, recall: 0.8, averagePrecision: 0.85, perTagPerformance: [] }),
    listTags: async () => [],
    ...cv,
  });
  stub(REPO('aiModelRepo.js'), {
    getMaxVersion: async () => 2,
    markPublished: async (id, d) => { calls.markPublished.push({ id, ...d }); },
    setActiveVersion: async (cat, id) => { calls.setActiveVersion.push({ cat, id }); },
    updatePredictionResourceId: async (id, res) => { calls.updateRes.push({ id, res }); },
    setTrainingError: async (id, msg) => { calls.setTrainingError.push({ id, msg }); },
    markTrainingFailed: async (id, msg) => { calls.markTrainingFailed.push({ id, msg }); },
    markTrained: async (id) => { calls.markTrained.push(id); },
    saveMetrics: async () => {},
    updateStatus: async () => {},
    findById: async (id) => ({ detection_model_id: id, category_id: 7, prediction_resource_id: 'VIEJO-DE-LA-FILA' }),
    listAll: async () => [],
    ...repo,
  });
  delete require.cache[SVC('modelTrainingService.js')];
  return { svc: require(SVC('modelTrainingService.js')), calls };
}
const MODEL = { detection_model_id: 1, category_id: 7, prediction_resource_id: 'VIEJO-DE-LA-FILA' };

test('modelProvider.leerPredictionResourceId: vacío, truncado y válido', () => {
  const { leerPredictionResourceId } = require(SVC('modelProvider.js'));
  process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID = '';
  assert.equal(leerPredictionResourceId().ok, false);
  process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CognitiveServices';
  assert.match(leerPredictionResourceId().error, /truncada/);
  process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID = VALID;
  assert.deepEqual(leerPredictionResourceId(), { ok: true, value: VALID });
});

test('publica con el Resource ID del .env (no el de la fila), versión +1, nombre v{n}-fecha y lo graba en la fila', async () => {
  process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID = VALID;
  const { svc, calls } = load();
  await svc.publishAndActivate(MODEL, 'proj-1', 'it-1');
  const hoy = new Date().toISOString().slice(0, 10);
  assert.equal(calls.publish[0].resId, VALID);
  assert.equal(calls.publish[0].name, `v3-${hoy}`);
  assert.deepEqual(calls.markPublished, [{ id: 1, modelVersion: 3, lastPublishName: `v3-${hoy}` }]);
  assert.deepEqual(calls.setActiveVersion, [{ cat: 7, id: 1 }]);
  assert.deepEqual(calls.updateRes, [{ id: 1, res: VALID }]);
  assert.equal(calls.setTrainingError.length, 0);
});

test('Resource ID inválido en el .env → NO intenta publicar, queda el motivo', async () => {
  process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID = 'cualquier-cosa';
  const { svc, calls } = load();
  await svc.publishAndActivate(MODEL, 'proj-1', 'it-1');
  assert.equal(calls.publish.length, 0);
  assert.equal(calls.markPublished.length, 0);
  assert.match(calls.setTrainingError[0].msg, /^Publicación pendiente/);
});

test('Custom Vision rechaza la publicación → queda TRAINED con el motivo, sin activar', async () => {
  process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID = VALID;
  const { svc, calls } = load({ cv: { publishIteration: async () => { throw new Error('Custom Vision 400: BadRequestInvalidPublishTarget'); } } });
  await svc.publishAndActivate(MODEL, 'proj-1', 'it-1');
  assert.equal(calls.markPublished.length, 0);
  assert.equal(calls.setActiveVersion.length, 0);
  assert.match(calls.setTrainingError[0].msg, /InvalidPublishTarget/);
});

test('recuperación al arrancar: retoma, completa, falla y destraba según corresponda', async () => {
  process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID = VALID;
  const modelos = [
    { detection_model_id: 10, category_id: 1, status: 'TRAINING',        customvision_project_id: 'p-entrenando' },
    { detection_model_id: 11, category_id: 2, status: 'TRAINING',        customvision_project_id: 'p-completo' },
    { detection_model_id: 12, category_id: 3, status: 'TRAINING',        customvision_project_id: 'p-fallido' },
    { detection_model_id: 13, category_id: 4, status: 'IMAGES_UPLOADED', customvision_project_id: 'p-x' },
    { detection_model_id: 14, category_id: 5, status: 'PUBLISHED',       customvision_project_id: 'p-ok' },
  ];
  const iters = {
    'p-entrenando': [{ id: 'viejo', status: 'Completed', created: '2026-09-01' }, { id: 'nuevo', status: 'Training', created: '2026-10-10' }],
    'p-completo':   [{ id: 'c1', status: 'Completed', created: '2026-10-10' }],
    'p-fallido':    [{ id: 'f1', status: 'Failed', created: '2026-10-10' }],
  };
  const { svc, calls } = load({
    cv:   { listIterations: async (p) => iters[p] ?? [] },
    repo: { listAll: async () => modelos },
  });
  const r = await svc.recuperarEntrenamientosAlArrancar();
  await sleep(100); // deja correr el polling/completado en background

  assert.deepEqual(r, { reanudados: 1, completados: 1, fallidos: 2 });
  assert.ok(calls.getIteration.includes('nuevo'), 'retoma el polling de la ÚLTIMA iteración, no de la vieja');
  assert.ok(calls.markTrained.includes(11) && calls.markTrained.includes(10), 'los dos que completan avanzan trained_at');
  assert.deepEqual(calls.markTrainingFailed.map(c => c.id).sort(), [12, 13]);
  assert.match(calls.markTrainingFailed.find(c => c.id === 13).msg, /IMAGES_UPLOADED/);
  assert.ok(!calls.markTrainingFailed.some(c => c.id === 14), 'no toca modelos PUBLISHED');
});
