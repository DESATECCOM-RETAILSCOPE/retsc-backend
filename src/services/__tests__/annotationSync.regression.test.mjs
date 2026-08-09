// Prueba de regresión del bug de autocorrección de cv_sync_status (fix 2026-08-08).
//
// Bug real encontrado en producción: category_id=2 / canal OMT tenía 15 fotos aprobadas con
// el 100% de sus cajitas YA sincronizadas en Custom Vision (cv_region_id poblado en las 710
// anotaciones), pero la columna de la FOTO (cv_sync_status) seguía en 'PENDING'. Como
// checkAndUpdateThreshold cuenta fotos por cv_sync_status='SYNCED', el entrenamiento
// automático nunca se disparaba pese a que Custom Vision ya tenía todo lo necesario.
//
// Causa: en syncRegionsForPhoto(), la rama "todas las cajitas ya tenían cv_region_id" salía
// con `return` sin llamar a markSynced() — no había forma de que un futuro re-sync
// autocorrigiera el estado de la foto.
//
// Sin BD ni Azure: todas las dependencias de annotationSyncService se stubean vía
// require.cache (mismo patrón que shelfPhotoUpload.regression.test.mjs).
//
// Correr: node src/services/__tests__/annotationSync.regression.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SVC_DIR = path.join(process.cwd(), 'src', 'services');
const abs = (p) => require.resolve(path.join(SVC_DIR, p));

let calls;
function resetCalls() {
  calls = { updateCvSync: [], updateCvRegionId: [], createImageRegions: [], updateStatus: [] };
}

function makeAnnotation(id, hasCvRegion) {
  return {
    annotation_id: id,
    bbox_left: 0.1, bbox_top: 0.1, bbox_width: 0.2, bbox_height: 0.2,
    cv_region_id: hasCvRegion ? `region-${id}` : null,
  };
}

function installStubs({ annotations, model = null }) {
  const stub = (relPath, exports) => { const id = abs(relPath); require.cache[id] = { id, filename: id, loaded: true, exports }; };

  stub('../repositories/annotationRepo', {
    listByPhoto: async () => annotations,
    updateCvRegionId: async (annotationId, regionId) => { calls.updateCvRegionId.push({ annotationId, regionId }); },
  });
  stub('../repositories/trainingPhotoRepo', {
    findById: async (photoId) => ({
      photo_id: photoId, category_id: 2, canal: 'OMT',
      photo_notes: 'blob:dtc-x/omt/x.jpg | sha256:' + 'a'.repeat(64) + ' | cvImageId:cv-existing-123',
      blob_path: 'dtc-x/omt/x.jpg',
    }),
    updateCvSync: async (photoId, { syncStatus, syncError }) => { calls.updateCvSync.push({ photoId, syncStatus, syncError }); return {}; },
    countSyncedSinceByCategoryChannel: async () => 0,
  });
  stub('../repositories/aiModelRepo', {
    findByCategoryId: async () => model,
    updateStatus: async (id, status) => { calls.updateStatus.push({ id, status }); },
  });
  stub('./customVisionService', {
    isConfigured: () => true,
    ensureTag: async (_projectId, canal) => ({ id: `tag-${canal}` }),
    createImageRegions: async (_projectId, regions) => {
      calls.createImageRegions.push(regions);
      // Devuelve una región creada por cada pedida, con las mismas coords (para que
      // coordsMatch() las correlacione de vuelta a su anotación de origen).
      return regions.map((r, i) => ({ regionId: `new-region-${i}`, left: r.left, top: r.top, width: r.width, height: r.height }));
    },
    deleteImageRegion: async () => {},
    createImageFromData: async () => ({ cvImageId: 'cv-auto-registered' }),
  });
  stub('./modelTrainingService', {
    startTraining: async () => ({ status: 'TRAINING' }),
  });
  stub('./blobStorageService', {
    downloadFromContainer: async () => Buffer.from('fake-image-bytes'),
  });
  stub('../utils/imageHasher', {
    hashBuffer: () => 'b'.repeat(64),
  });
}

function loadServiceFresh() {
  delete require.cache[abs('./annotationSyncService')];
  return require(abs('./annotationSyncService'));
}

test('todas las cajitas ya tenían cv_region_id → ahora SÍ marca la foto como SYNCED (antes se quedaba en PENDING para siempre)', async () => {
  resetCalls();
  const annotations = [makeAnnotation(1, true), makeAnnotation(2, true), makeAnnotation(3, true)];
  installStubs({ annotations, model: null }); // model=null → checkAndUpdateThreshold corta temprano, no molesta
  const { syncApprovedPhoto } = loadServiceFresh();

  const result = await syncApprovedPhoto(77, {});

  assert.equal(calls.createImageRegions.length, 0, 'no debe reenviar nada a Custom Vision — ya estaba todo sincronizado');
  assert.equal(calls.updateCvSync.length, 1, 'debe llamar a updateCvSync exactamente una vez para asentar el estado de la foto');
  assert.equal(calls.updateCvSync[0].photoId, 77);
  assert.equal(calls.updateCvSync[0].syncStatus, 'SYNCED');
  assert.equal(calls.updateCvRegionId.length, 0, 'no hay regiones nuevas — el mapa que recibe markSynced está vacío');
  assert.equal(result.synced, true);
});

test('sync normal (cajitas SIN cv_region_id todavía) sigue funcionando como antes', async () => {
  resetCalls();
  const annotations = [makeAnnotation(10, false), makeAnnotation(11, false)];
  installStubs({ annotations, model: { detection_model_id: 1, customvision_project_id: 'proj-123', status: 'PROJECT_CREATED', trained_at: null } });
  const { syncApprovedPhoto } = loadServiceFresh();

  await syncApprovedPhoto(88, {});

  assert.equal(calls.createImageRegions.length, 1, 'debe enviar las cajitas pendientes a Custom Vision');
  assert.equal(calls.createImageRegions[0].length, 2);
  assert.equal(calls.updateCvRegionId.length, 2, 'cada anotación nueva debe guardar su cv_region_id');
  assert.equal(calls.updateCvSync.length, 1);
  assert.equal(calls.updateCvSync[0].syncStatus, 'SYNCED');
});
