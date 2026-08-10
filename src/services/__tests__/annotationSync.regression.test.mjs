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

// bbox_left único por id (en vez de un valor fijo compartido) para que coordsMatch() pueda
// correlacionar de forma NO ambigua cuál anotación corresponde a cuál región devuelta —
// necesario para el test de fallo parcial, que verifica CUÁLES ids específicos se confirmaron.
function makeAnnotation(id, hasCvRegion) {
  return {
    annotation_id: id,
    bbox_left: id / 100, bbox_top: 0.1, bbox_width: 0.05, bbox_height: 0.05,
    cv_region_id: hasCvRegion ? `region-${id}` : null,
  };
}

function installStubs({ annotations, model = null, createImageRegionsBehavior = 'normal' }) {
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
    listTags: async () => [],
    deleteTag: async () => {},
    createImageRegions: async (_projectId, regions, opts) => {
      calls.createImageRegions.push(regions);

      if (createImageRegionsBehavior === 'throwWithPartial') {
        // Simula un fallo de lote 2 en el que el llamador NO llega a usar onBatchCreated
        // (para probar la defensa-en-profundidad del catch en syncRegionsForPhoto, no el
        // camino feliz de onBatchCreated — ese ya tiene su propio test en
        // customVisionRegions.regression.test.mjs). Confirma las primeras 2 regiones antes
        // de "fallar" con las que falten.
        const confirmed = regions.slice(0, 2).map((r, i) => ({ regionId: `region-${i}`, left: r.left, top: r.top, width: r.width, height: r.height }));
        const err = new Error('Custom Vision 400: fallo simulado en el segundo lote');
        err.partialCreated = confirmed;
        throw err;
      }

      // Devuelve una región creada por cada pedida, con las mismas coords (para que
      // coordsMatch() las correlacione de vuelta a su anotación de origen) — y notifica
      // onBatchCreated como hace la implementación real, un solo lote acá (<=64 regiones).
      const created = regions.map((r, i) => ({ regionId: `new-region-${i}`, left: r.left, top: r.top, width: r.width, height: r.height }));
      if (opts?.onBatchCreated) await opts.onBatchCreated(created);
      return created;
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

test('fallo de lote parcial (F1.1/Fase 2): lo confirmado ANTES del fallo se persiste igual, la foto queda ERROR no SYNCED', async () => {
  resetCalls();
  const annotations = [makeAnnotation(20, false), makeAnnotation(21, false), makeAnnotation(22, false)];
  installStubs({
    annotations,
    model: { detection_model_id: 1, customvision_project_id: 'proj-123', status: 'PROJECT_CREATED', trained_at: null },
    createImageRegionsBehavior: 'throwWithPartial',
  });
  const { syncApprovedPhoto } = loadServiceFresh();

  const result = await syncApprovedPhoto(99, {});

  const persistedIds = calls.updateCvRegionId.map(c => c.annotationId);
  assert.equal(persistedIds.length, 2, 'las 2 regiones confirmadas antes del fallo deben persistirse');
  assert.ok(persistedIds.includes(20) && persistedIds.includes(21), 'antes de este fix, estas 2 regiones reales en CV se perdían por completo');
  assert.ok(!persistedIds.includes(22), 'la tercera nunca se confirmó — no debe tener region_id inventado');

  assert.equal(calls.updateCvSync.length, 1);
  assert.equal(calls.updateCvSync[0].syncStatus, 'ERROR', 'la foto no puede quedar SYNCED si una cajita real quedó sin confirmar');
  assert.equal(result.synced, true); // syncApprovedPhoto no lanza — el fallo se registra en cv_sync_status, no como excepción
});
