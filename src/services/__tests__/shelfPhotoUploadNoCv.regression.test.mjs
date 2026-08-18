import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Blinda: la SUBIDA de fotos de góndola va SOLO al Blob Storage. No debe llamar a Custom
// Vision ni persistir un cv_image_id (menos aún un 'stub-...').
const require = createRequire(import.meta.url);
const SVC_DIR = path.join(process.cwd(), 'src', 'services');
const abs = (p) => require.resolve(path.join(SVC_DIR, p));

let calls;
function resetCalls() { calls = { uploadToContainer: [], trainingInsert: [], cvCalled: false }; }

function installStubs() {
  const stub = (relPath, exports) => { const id = abs(relPath); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  stub('./shelfPhotoQualityService', { validateQualityMetrics: async () => ({ accepted: true, hash: 'a'.repeat(64), metrics: { width: 1200, height: 900, sharpness: 0.9, brightness: 0.5 } }) });
  stub('./azureVisionService', { analyzeCaption: async () => ({ stub: true, confidence: 1 }), isShelf: async () => ({ stub: true, isShelf: true }) });
  // Guardia: si la subida vuelve a tocar Custom Vision, el test falla.
  stub('./customVisionService', { createImageFromData: async () => { calls.cvCalled = true; throw new Error('La subida NO debe registrar en Custom Vision'); } });
  stub('./blobStorageService', { uploadToContainer: async (args) => { calls.uploadToContainer.push(args); return { url: `https://x/global-shelf-training/${args.blobPath}`, mode: 'azure' }; } });
  stub('../utils/imageHasher', { hashBuffer: () => 'a'.repeat(64) });
  stub('../utils/shelfPhotoFilenameGenerator', { generateFilename: ({ categoriaSlug, canal }) => `${categoriaSlug}-${canal}-fixed.jpg` });
  stub('../utils/categoryNameNormalizer', { normalizeName: (s) => s.toLowerCase().replace(/\s+/g, '-') });
  stub('../repositories/categoryRepo', { findById: async () => ({ Category_dsc: 'Desodorantes Corporales', is_smart_dtc: 1 }) });
  stub('../repositories/shelfPhotoRepo', { findByHashGlobal: () => { throw new Error('no tocar RETSC_EX_SHELFPHOTO'); } });
  stub('../repositories/trainingPhotoRepo', { findByHashAndCanal: async () => null, insert: async (row) => { calls.trainingInsert.push(row); return { photo_id: 1000 }; }, countValidatedApprovedByCategoryChannel: async () => 0 });
  stub('../repositories/aiModelRepo', { findByCategoryId: async () => null, updateStatus: async () => {} });
}
function loadFresh() { delete require.cache[abs('./shelfPhotoUploadService')]; return require(abs('./shelfPhotoUploadService')); }

test('la subida escribe el blob y NO llama a Custom Vision', async () => {
  resetCalls(); installStubs();
  const { uploadShelfPhoto } = loadFresh();
  const res = await uploadShelfPhoto({ buffer: Buffer.from('x'), dtcCategoryId: 42, canal: 'OMT', uploadedBy: 44, enterpriseId: 35 });
  assert.equal(calls.uploadToContainer.length, 1, 'debe subir el blob');
  assert.equal(calls.cvCalled, false, 'NO debe registrar en Custom Vision al subir');
  assert.match(res.blobPath, /\/omt\//);
});

test('no persiste ningún cv_image_id al subir (ni stub)', async () => {
  resetCalls(); installStubs();
  const { uploadShelfPhoto } = loadFresh();
  await uploadShelfPhoto({ buffer: Buffer.from('x'), dtcCategoryId: 42, canal: 'OMT', uploadedBy: 44, enterpriseId: 35 });
  const row = calls.trainingInsert[0];
  assert.equal(row.cv_image_id, null, 'cv_image_id debe quedar null — lo completa el sync');
  assert.ok(!String(row.cv_image_id ?? '').startsWith('stub-'), 'nunca debe guardarse un id stub');
});
