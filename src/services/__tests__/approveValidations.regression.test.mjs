// Ciclo 5 (A1) — validaciones de aprobación en annotationController:
//   · lote mezclado (más de un canal o categoría) → 400 ERR_LOTE_MEZCLADO, no aprueba nada
//   · foto con > 300 cajitas → 409 ERR_DEMASIADAS_CAJITAS (individual) / fallida (lote)
//   · FIX: el lote evalúa el umbral con la categoría real (dtc_category_id), no undefined
// Sin BD ni Azure: dependencias stubeadas vía require.cache.
// Correr: node src/services/__tests__/approveValidations.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');
const abs = (p) => require.resolve(path.join(SRC, p));

let calls;
function photo(id, { canal = 'OMT', cat = 7, boxes = 3 } = {}) {
  return { photo_id: id, canal, dtc_category_id: cat,
    regions: Array.from({ length: boxes }, (_, i) => ({ annotation_id: i, bbox_left: 0.1 })) };
}
function install(photos) {
  calls = { approved: [], threshold: [] };
  const stub = (p, e) => { const id = abs(p); require.cache[id] = { id, filename: id, loaded: true, exports: e }; };
  stub('repositories/trainingPhotoRepo.js', {
    getPhotoWithRegions: async (id) => photos[id] ?? null,
    approvePhoto: async (id) => { calls.approved.push(id); return { photo_id: id }; },
  });
  stub('repositories/annotationRepo.js', { validateAllByPhoto: async () => [] });
  stub('services/annotationSyncService.js', {
    syncApprovedPhoto: async () => ({ synced: true }),
    evaluarEntrenamiento: async (catId) => { calls.threshold.push(catId); return { triggered: false }; },
  });
  stub('services/annotationService.js', {});
  stub('services/blobStorageService.js', {});
  delete require.cache[abs('controllers/annotationController.js')];
  return require(abs('controllers/annotationController.js'));
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const req = (body, params = {}) => ({ body, params, user: { userId: 1 } });

test('lote con dos canales → 400 ERR_LOTE_MEZCLADO y no aprueba ninguna', async () => {
  const c = install({ 1: photo(1, { canal: 'OMT' }), 2: photo(2, { canal: 'DTT' }) });
  const res = fakeRes();
  await c.approvePhotosBatch(req({ photoIds: [1, 2] }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.errorCode, 'ERR_LOTE_MEZCLADO');
  assert.equal(calls.approved.length, 0);
});

test('lote con dos categorías → 400 ERR_LOTE_MEZCLADO', async () => {
  const c = install({ 1: photo(1, { cat: 7 }), 2: photo(2, { cat: 8 }) });
  const res = fakeRes();
  await c.approvePhotosBatch(req({ photoIds: [1, 2] }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.approved.length, 0);
});

test('FIX: lote válido evalúa el umbral UNA vez con la categoría real (no undefined)', async () => {
  const c = install({ 1: photo(1), 2: photo(2), 3: photo(3) });
  const res = fakeRes();
  await c.approvePhotosBatch(req({ photoIds: [1, 2, 3] }), res);
  assert.deepEqual(res.body.aprobadas, [1, 2, 3]);
  assert.deepEqual(calls.threshold, [7]);
});

test('lote: foto con 301 cajitas queda en fallidas, el resto se aprueba', async () => {
  const c = install({ 1: photo(1), 2: photo(2, { boxes: 301 }) });
  const res = fakeRes();
  await c.approvePhotosBatch(req({ photoIds: [1, 2] }), res);
  assert.deepEqual(res.body.aprobadas, [1]);
  assert.equal(res.body.fallidas[0].photoId, 2);
  assert.match(res.body.fallidas[0].message, /300/);
});

test('individual: 301 cajitas → 409 ERR_DEMASIADAS_CAJITAS y no se aprueba', async () => {
  const c = install({ 5: photo(5, { boxes: 301 }) });
  const res = fakeRes();
  await c.approvePhoto(req({}, { photoId: '5' }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.errorCode, 'ERR_DEMASIADAS_CAJITAS');
  assert.equal(calls.approved.length, 0);
});

test('individual: 300 cajitas exactas → se aprueba', async () => {
  const c = install({ 6: photo(6, { boxes: 300 }) });
  const res = fakeRes();
  await c.approvePhoto(req({}, { photoId: '6' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.approved, [6]);
});
