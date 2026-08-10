// Prueba de regresión de los dos umbrales de (re)entrenamiento (pedido de jefatura, 2026-08-10).
//
// Antes había un solo umbral (SHELF_TRAINING_THRESHOLD, 15) aplicado igual al primer
// entrenamiento y a los reentrenamientos siguientes. El conteo "desde trained_at" por
// categoría+canal (countSyncedSinceByCategoryChannel) ya existía y ya acotaba correctamente el
// conteo — lo que faltaba era comparar ese conteo contra un umbral DISTINTO y ajustable
// (RETSC_CONFIG.RETRAIN_BATCH_SIZE) cuando trained_at ya tiene valor.
//
// Sin BD ni Azure: se stubean aiModelRepo/trainingPhotoRepo/modelTrainingService/configService
// vía require.cache — mismo patrón que annotationSync.regression.test.mjs.
//
// Correr: node src/services/__tests__/retrainThreshold.regression.test.mjs

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
  delete require.cache[absSvc('./annotationSyncService')];
  return require(absSvc('./annotationSyncService'));
}

// countsByCanal: { OMT: n, DTT: n, CONVENIENCE: n } — conteo YA ACOTADO "desde trained_at" que
// devolvería countSyncedSinceByCategoryChannel para cada canal.
function installStubs({ model, countsByCanal, configValue }) {
  const calls = { updateStatus: [], startTraining: [], getConfigValue: [] };

  stub(absRepo('aiModelRepo'), {
    findByCategoryId: async () => model,
    updateStatus: async (id, status) => { calls.updateStatus.push({ id, status }); },
  });
  stub(absRepo('trainingPhotoRepo'), {
    countSyncedSinceByCategoryChannel: async (categoryId, canal) => countsByCanal[canal] ?? 0,
  });
  stub(absSvc('./modelTrainingService'), {
    startTraining: async (categoryId, adminUserId) => { calls.startTraining.push({ categoryId, adminUserId }); return { status: 'TRAINING' }; },
  });
  stub(absSvc('./configService'), {
    getNumberConfig: async (clave, fallback, opts) => {
      calls.getConfigValue.push(clave);
      if (configValue === undefined) return fallback; // simula fila ausente
      return configValue;
    },
  });
  return calls;
}

test('primer entrenamiento (trained_at=NULL): 15 SYNCED en un canal → dispara', async () => {
  const model = { detection_model_id: 1, category_id: 2, status: 'PROJECT_CREATED', trained_at: null };
  const calls = installStubs({ model, countsByCanal: { OMT: 15, DTT: 0, CONVENIENCE: 0 } });
  const { checkAndUpdateThreshold } = loadServiceFresh();

  await checkAndUpdateThreshold(2);

  assert.equal(calls.updateStatus.length, 1, 'debe marcar IMAGES_UPLOADED');
  assert.equal(calls.updateStatus[0].status, 'IMAGES_UPLOADED');
  assert.equal(calls.startTraining.length, 1, 'debe disparar startTraining');
  assert.equal(calls.getConfigValue.length, 0, 'primer entrenamiento NO debe leer RETSC_CONFIG — el 15 es fijo en código');
});

test('primer entrenamiento (trained_at=NULL): 14 SYNCED → NO dispara', async () => {
  const model = { detection_model_id: 1, category_id: 2, status: 'PROJECT_CREATED', trained_at: null };
  const calls = installStubs({ model, countsByCanal: { OMT: 14, DTT: 0, CONVENIENCE: 0 } });
  const { checkAndUpdateThreshold } = loadServiceFresh();

  await checkAndUpdateThreshold(2);

  assert.equal(calls.updateStatus.length, 0, 'no debe disparar con 14/15');
  assert.equal(calls.startTraining.length, 0);
});

test('reentrenamiento (trained_at con valor): RETRAIN_BATCH_SIZE=10, 10 SYNCED nuevas → dispara', async () => {
  const model = { detection_model_id: 1, category_id: 2, status: 'PUBLISHED', trained_at: new Date('2026-08-10T00:00:00Z') };
  const calls = installStubs({ model, countsByCanal: { OMT: 10, DTT: 0, CONVENIENCE: 0 }, configValue: 10 });
  const { checkAndUpdateThreshold } = loadServiceFresh();

  await checkAndUpdateThreshold(2);

  assert.equal(calls.getConfigValue.length, 1, 'reentrenamiento SÍ debe leer RETSC_CONFIG.RETRAIN_BATCH_SIZE');
  assert.equal(calls.getConfigValue[0], 'RETRAIN_BATCH_SIZE');
  assert.equal(calls.updateStatus.length, 1, 'debe marcar IMAGES_UPLOADED con 10/10 nuevas');
  assert.equal(calls.startTraining.length, 1);
});

test('reentrenamiento: 9 SYNCED nuevas (< RETRAIN_BATCH_SIZE=10) → NO dispara', async () => {
  const model = { detection_model_id: 1, category_id: 2, status: 'PUBLISHED', trained_at: new Date('2026-08-10T00:00:00Z') };
  const calls = installStubs({ model, countsByCanal: { OMT: 9, DTT: 0, CONVENIENCE: 0 }, configValue: 10 });
  const { checkAndUpdateThreshold } = loadServiceFresh();

  await checkAndUpdateThreshold(2);

  assert.equal(calls.updateStatus.length, 0, 'no debe disparar con 9/10');
  assert.equal(calls.startTraining.length, 0);
});

test('reentrenamiento: NO cuenta fotos viejas — el conteo ya viene acotado por countSyncedSinceByCategoryChannel(trained_at), aunque el total histórico sea mucho mayor', async () => {
  // Simula: 40 SYNCED en total, pero solo 8 son POSTERIORES a trained_at (lo que devolvería el
  // repo real ya filtrando por created_at > trained_at) — el umbral compara contra ESE 8, no
  // contra el histórico de 40.
  const model = { detection_model_id: 1, category_id: 2, status: 'PUBLISHED', trained_at: new Date('2026-08-10T00:00:00Z') };
  const calls = installStubs({ model, countsByCanal: { OMT: 8, DTT: 0, CONVENIENCE: 0 }, configValue: 10 });
  const { checkAndUpdateThreshold } = loadServiceFresh();

  await checkAndUpdateThreshold(2);

  assert.equal(calls.updateStatus.length, 0, 'con 8 nuevas (aunque haya 40 históricas) no debe disparar contra un umbral de 10');
});

test('RETSC_CONFIG.RETRAIN_BATCH_SIZE ausente/no parseable → usa fallback (10), no rompe', async () => {
  const model = { detection_model_id: 1, category_id: 2, status: 'PUBLISHED', trained_at: new Date('2026-08-10T00:00:00Z') };
  // configValue undefined → el stub de getNumberConfig simula fila ausente y devuelve el fallback pasado por el caller
  const calls = installStubs({ model, countsByCanal: { OMT: 10, DTT: 0, CONVENIENCE: 0 }, configValue: undefined });
  const { checkAndUpdateThreshold } = loadServiceFresh();

  await checkAndUpdateThreshold(2);

  assert.equal(calls.updateStatus.length, 1, 'con el fallback de 10 (mismo valor pedido), 10 SYNCED debe disparar igual');
});

test('no re-dispara mientras status=TRAINING (guard existente, no tocado por este cambio)', async () => {
  const model = { detection_model_id: 1, category_id: 2, status: 'TRAINING', trained_at: new Date('2026-08-10T00:00:00Z') };
  const calls = installStubs({ model, countsByCanal: { OMT: 999, DTT: 999, CONVENIENCE: 999 }, configValue: 10 });
  const { checkAndUpdateThreshold } = loadServiceFresh();

  await checkAndUpdateThreshold(2);

  assert.equal(calls.updateStatus.length, 0, 'no debe re-evaluar mientras hay un training en curso, aunque el conteo ya sobre-cumpla el umbral');
  assert.equal(calls.startTraining.length, 0);
  assert.equal(calls.getConfigValue.length, 0, 'ni siquiera debe llegar a leer RETSC_CONFIG — corta antes por el guard de status');
});
