import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Regresión del flujo de carga de fotos de góndola.
// FIX 2026-08-12 (dos fixes de la misma tanda):
//   1. El flujo NO debe tocar RETSC_EX_SHELFPHOTO (tabla de EJECUCIÓN de otro equipo). El
//      dedup se hace 100% contra RETSC_AI_TRAINING_PHOTOS (columna image_hash propia vía
//      findByHashAndCanal).
//   2. La subida ya NO registra la imagen en Custom Vision (Etapa 6 eliminada) — eso pasa al
//      sincronizar la anotación aprobada (ver shelfPhotoUploadNoCv.regression.test.mjs para el
//      test dedicado a esto). Acá solo se ajustó el stub de customVisionService para que tire
//      si el flujo lo llama, como defensa adicional.
// Estos tests blindan ambos: si alguien vuelve a llamar shelfPhotoRepo o customVisionService,
// el stub tira y el test falla.
const require = createRequire(import.meta.url);
const SVC_DIR = path.join(process.cwd(), 'src', 'services');
const abs = (p) => require.resolve(path.join(SVC_DIR, p));

let calls;
function resetCalls() { calls = { uploadToContainer: [], trainingInsert: [], shelfPhotoRepoCalled: false, cvCalled: false }; }

function installStubs({ hashInThisChannel = null } = {}) {
  const stub = (relPath, exports) => { const id = abs(relPath); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  stub('./shelfPhotoQualityService', { validateQualityMetrics: async () => ({ accepted: true, hash: 'a'.repeat(64), metrics: { width: 1200, height: 900, sharpness: 0.9, brightness: 0.5 } }) });
  stub('./azureVisionService', { analyzeCaption: async () => ({ stub: true, confidence: 1 }), isShelf: async () => ({ stub: true, isShelf: true }) });
  stub('./customVisionService', { createImageFromData: async () => { calls.cvCalled = true; throw new Error('La subida NO debe registrar en Custom Vision (Etapa 6 eliminada)'); } });
  stub('./blobStorageService', { uploadToContainer: async (args) => { calls.uploadToContainer.push(args); return { url: `https://x.blob.core.windows.net/global-shelf-training/${args.blobPath}`, mode: 'azure' }; } });
  stub('../utils/imageHasher', { hashBuffer: () => 'a'.repeat(64) });
  stub('../utils/shelfPhotoFilenameGenerator', { generateFilename: ({ categoriaSlug, canal }) => `${categoriaSlug}-${canal}-fixedname.jpg` });
  stub('../utils/categoryNameNormalizer', { normalizeName: (s) => s.toLowerCase().replace(/\s+/g, '-') });
  stub('../repositories/categoryRepo', { findById: async () => ({ Category_dsc: 'Desodorantes Corporales', is_smart_dtc: 1 }) });
  // Guardia: si el flujo vuelve a tocar RETSC_EX_SHELFPHOTO, cualquier método marca el flag y tira.
  const boom = () => { calls.shelfPhotoRepoCalled = true; throw new Error('El flujo NO debe tocar RETSC_EX_SHELFPHOTO'); };
  stub('../repositories/shelfPhotoRepo', { findByHashGlobal: boom, findByHash: boom, insert: boom });
  stub('../repositories/trainingPhotoRepo', { findByHashAndCanal: async () => hashInThisChannel, insert: async (row) => { calls.trainingInsert.push(row); return { photo_id: 1000 }; }, countValidatedApprovedByCategoryChannel: async () => 0 });
  stub('../repositories/aiModelRepo', { findByCategoryId: async () => null, updateStatus: async () => {} });
}
function loadServiceFresh() { delete require.cache[abs('./shelfPhotoUploadService')]; return require(abs('./shelfPhotoUploadService')); }

test('imagen nueva → sube el blob a /omt/, graba en TRAINING_PHOTOS y NO toca RETSC_EX_SHELFPHOTO', async () => {
  resetCalls(); installStubs({ hashInThisChannel: null });
  const { uploadShelfPhoto } = loadServiceFresh();
  const res = await uploadShelfPhoto({ buffer: Buffer.from('x'), dtcCategoryId: 42, canal: 'OMT', uploadedBy: 44, enterpriseId: 35 });
  assert.equal(calls.uploadToContainer.length, 1);
  assert.match(res.blobPath, /\/omt\//);
  assert.equal(calls.trainingInsert.length, 1);
  assert.match(calls.trainingInsert[0].blob_path, /\/omt\//);
  assert.equal(calls.trainingInsert[0].cv_image_id, null, 'cv_image_id lo completa el sync, no la subida');
  assert.equal(calls.shelfPhotoRepoCalled, false, 'no debe tocar RETSC_EX_SHELFPHOTO');
  assert.equal(calls.cvCalled, false, 'no debe registrar en Custom Vision al subir');
});

test('misma imagen ya en OTRO canal (DTT) → se sube igual a /omt/ sin tocar RETSC_EX_SHELFPHOTO', async () => {
  resetCalls(); installStubs({ hashInThisChannel: null }); // no existe para OMT
  const { uploadShelfPhoto } = loadServiceFresh();
  const res = await uploadShelfPhoto({ buffer: Buffer.from('x'), dtcCategoryId: 42, canal: 'OMT', uploadedBy: 44, enterpriseId: 35 });
  assert.equal(calls.uploadToContainer.length, 1);
  assert.match(res.blobPath, /\/omt\//);
  assert.equal(calls.shelfPhotoRepoCalled, false);
});

test('duplicado exacto en el MISMO canal → 409 y no sube nada', async () => {
  resetCalls(); installStubs({ hashInThisChannel: { photo_id: 55 } });
  const { uploadShelfPhoto } = loadServiceFresh();
  await assert.rejects(
    () => uploadShelfPhoto({ buffer: Buffer.from('x'), dtcCategoryId: 42, canal: 'OMT', uploadedBy: 44, enterpriseId: 35 }),
    (err) => err.statusCode === 409 && err.errorCode === 'ERR_DUPLICATE_IMAGE'
  );
  assert.equal(calls.uploadToContainer.length, 0);
  assert.equal(calls.shelfPhotoRepoCalled, false);
});
