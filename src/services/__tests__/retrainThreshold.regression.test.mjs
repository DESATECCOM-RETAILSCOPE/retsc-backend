// Ciclo 5 (A3) — evaluarEntrenamiento(): única función de disparo del entrenamiento automático.
//
//   · Conteo POR CATEGORÍA (todos los canales suman) — antes era por canal y 10 OMT + 5 DTT
//     nunca llegaba a 15.
//   · Umbrales desde RETSC_CONFIG: FIRST_TRAIN_MIN_PHOTOS (15, mínimo técnico de CV) y
//     RETRAIN_BATCH_SIZE (5). Antes el primero salía de la env SHELF_TRAINING_THRESHOLD.
//   · Reentrenamiento cuenta solo las aprobadas después de trained_at.
//   · Toma atómica del modelo (claimForTraining): dos aprobaciones simultáneas → un solo training.
//   · Nada de "dispara y olvida": si startTraining falla → TRAINING_FAILED, nunca colgado.
//   · Nunca lanza (la aprobación ya quedó guardada).
//
// Sin BD ni Azure: dependencias stubeadas vía require.cache.
// Correr: node src/services/__tests__/retrainThreshold.regression.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SVC_DIR  = path.join(process.cwd(), 'src', 'services');
const REPO_DIR = path.join(process.cwd(), 'src', 'repositories');
const absSvc  = (p) => require.resolve(path.join(SVC_DIR, p));
const absRepo = (p) => require.resolve(path.join(REPO_DIR, p));
const stub = (abs, exports) => { require.cache[abs] = { id: abs, filename: abs, loaded: true, exports }; };

function loadServiceFresh() {
  delete require.cache[absSvc('./annotationSyncService')];
  return require(absSvc('./annotationSyncService'));
}

// config: { FIRST_TRAIN_MIN_PHOTOS?, RETRAIN_BATCH_SIZE? } — clave ausente = fila ausente (fallback)
function installStubs({ model, count = 0, config = {}, claim = true, startTrainingError = null, findError = null }) {
  const calls = { count: [], claim: [], startTraining: [], markTrainingFailed: [], config: [] };
  stub(absRepo('aiModelRepo'), {
    findByCategoryId: async () => { if (findError) throw findError; return model; },
    claimForTraining: async (id) => { calls.claim.push(id); return claim; },
    markTrainingFailed: async (id, msg) => { calls.markTrainingFailed.push({ id, msg }); },
    updateStatus: async () => {},
  });
  stub(absRepo('trainingPhotoRepo'), {
    countSyncedSinceByCategory: async (categoryId, since) => { calls.count.push({ categoryId, since }); return count; },
  });
  stub(absSvc('./modelTrainingService'), {
    startTraining: async (categoryId) => {
      calls.startTraining.push(categoryId);
      if (startTrainingError) throw startTrainingError;
      return { status: 'TRAINING', iterationId: 'it-1' };
    },
  });
  stub(absSvc('./configService'), {
    getNumberConfig: async (clave, fallback, opts) => {
      calls.config.push({ clave, fallback, min: opts?.min });
      return clave in config ? config[clave] : fallback;
    },
  });
  return calls;
}

const NUEVO     = { detection_model_id: 1, category_id: 7, status: 'PROJECT_CREATED', trained_at: null };
const TRAINED_AT = new Date('2026-10-01T12:00:00Z');
const PUBLICADO = { detection_model_id: 1, category_id: 7, status: 'PUBLISHED', trained_at: TRAINED_AT };

test('primer entrenamiento: 15 aprobadas de la CATEGORÍA (canales sumados) → toma el modelo y entrena', async () => {
  const calls = installStubs({ model: NUEVO, count: 15 });
  const r = await loadServiceFresh().evaluarEntrenamiento(7);
  assert.equal(r.triggered, true);
  assert.deepEqual(calls.count, [{ categoryId: 7, since: null }], 'cuenta toda la categoría, sin fecha');
  assert.deepEqual(calls.claim, [1]);
  assert.deepEqual(calls.startTraining, [7]);
  assert.equal(calls.config[0].clave, 'FIRST_TRAIN_MIN_PHOTOS');
});

test('primer entrenamiento: 14 → no entrena ni toma el modelo', async () => {
  const calls = installStubs({ model: NUEVO, count: 14 });
  const r = await loadServiceFresh().evaluarEntrenamiento(7);
  assert.equal(r.reason, 'BAJO_UMBRAL');
  assert.equal(calls.claim.length, 0);
  assert.equal(calls.startTraining.length, 0);
});

test('FIRST_TRAIN_MIN_PHOTOS se lee con piso 15 (mínimo técnico de Custom Vision) y fallback 15', async () => {
  const calls = installStubs({ model: NUEVO, count: 0 });
  await loadServiceFresh().evaluarEntrenamiento(7);
  assert.deepEqual(calls.config[0], { clave: 'FIRST_TRAIN_MIN_PHOTOS', fallback: 15, min: 15 });
});

test('reentrenamiento: 5 aprobadas DESPUÉS de trained_at → entrena', async () => {
  const calls = installStubs({ model: PUBLICADO, count: 5 });
  const r = await loadServiceFresh().evaluarEntrenamiento(7);
  assert.equal(r.triggered, true);
  assert.deepEqual(calls.count, [{ categoryId: 7, since: TRAINED_AT }]);
  assert.deepEqual(calls.config[0], { clave: 'RETRAIN_BATCH_SIZE', fallback: 5, min: 1 });
});

test('reentrenamiento: 4 → no entrena', async () => {
  const calls = installStubs({ model: PUBLICADO, count: 4 });
  const r = await loadServiceFresh().evaluarEntrenamiento(7);
  assert.equal(r.reason, 'BAJO_UMBRAL');
  assert.equal(calls.startTraining.length, 0);
});

test('RETRAIN_BATCH_SIZE configurado en 8 → 7 no alcanza, 8 sí', async () => {
  let calls = installStubs({ model: PUBLICADO, count: 7, config: { RETRAIN_BATCH_SIZE: 8 } });
  assert.equal((await loadServiceFresh().evaluarEntrenamiento(7)).triggered, false);
  calls = installStubs({ model: PUBLICADO, count: 8, config: { RETRAIN_BATCH_SIZE: 8 } });
  assert.equal((await loadServiceFresh().evaluarEntrenamiento(7)).triggered, true);
});

test('modelo en TRAINING o IMAGES_UPLOADED → no cuenta ni dispara', async () => {
  for (const status of ['TRAINING', 'IMAGES_UPLOADED']) {
    const calls = installStubs({ model: { ...NUEVO, status }, count: 99 });
    const r = await loadServiceFresh().evaluarEntrenamiento(7);
    assert.equal(r.reason, 'EN_CURSO');
    assert.equal(calls.count.length, 0);
    assert.equal(calls.startTraining.length, 0);
  }
});

test('TRAINING_FAILED NO bloquea: la próxima aprobación reintenta', async () => {
  const calls = installStubs({ model: { ...NUEVO, status: 'TRAINING_FAILED' }, count: 15 });
  const r = await loadServiceFresh().evaluarEntrenamiento(7);
  assert.equal(r.triggered, true);
  assert.deepEqual(calls.startTraining, [7]);
});

test('carrera: otra aprobación ya tomó el modelo (claim=false) → no dispara un segundo training', async () => {
  const calls = installStubs({ model: NUEVO, count: 20, claim: false });
  const r = await loadServiceFresh().evaluarEntrenamiento(7);
  assert.equal(r.reason, 'EN_CURSO');
  assert.equal(calls.startTraining.length, 0);
});

test('startTraining falla → TRAINING_FAILED con el motivo, no lanza', async () => {
  const calls = installStubs({ model: NUEVO, count: 15, startTrainingError: new Error('Custom Vision 400: Not enough images per tag') });
  const r = await loadServiceFresh().evaluarEntrenamiento(7);
  assert.equal(r.reason, 'FALLO');
  assert.deepEqual(calls.markTrainingFailed, [{ id: 1, msg: 'Custom Vision 400: Not enough images per tag' }]);
});

test('sin categoryId (bug viejo de la masiva) → no hace nada, no lanza', async () => {
  const calls = installStubs({ model: NUEVO, count: 99 });
  const r = await loadServiceFresh().evaluarEntrenamiento(undefined);
  assert.equal(r.reason, 'SIN_CATEGORIA');
  assert.equal(calls.count.length, 0);
});

test('error de BD al leer el modelo → devuelve ERROR, nunca lanza', async () => {
  installStubs({ model: NUEVO, findError: new Error('timeout de conexión') });
  const r = await loadServiceFresh().evaluarEntrenamiento(7);
  assert.equal(r.reason, 'ERROR');
});

test('el alias viejo checkAndUpdateThreshold apunta a la misma función', async () => {
  const svc = (installStubs({ model: NUEVO }), loadServiceFresh());
  assert.equal(svc.checkAndUpdateThreshold, svc.evaluarEntrenamiento);
});
