// Prueba de regresión del bug de carga de fotos de góndola (fix 2026-08-05).
//
// Bug: cuando el hash de la imagen ya existía en RETSC_EX_SHELFPHOTO (típico al re-probar
// con las mismas fotos), la Etapa 5 de shelfPhotoUploadService.js saltaba el upload al
// blob y copiaba el blob_path del canal viejo — resultado: (a) fila en BD sin blob real,
// y (b) canal=OMT con blob_path bajo /dtt/ si esa imagen ya se había subido a DTT antes.
// Decisión de producto (María, 5/8/2026): la misma foto en varios canales DEBE tener su
// propio archivo por canal — el fix hace que el upload al blob sea SIEMPRE incondicional,
// y solo el INSERT de dedup en RETSC_EX_SHELFPHOTO queda condicional (evita violar su
// índice único por hash).
//
// Sin BD ni Azure: todas las dependencias de shelfPhotoUploadService se stubean vía
// require.cache (mismo patrón que scripts/test-user-role-gates.js).
//
// Correr: node src/services/__tests__/shelfPhotoUpload.regression.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SVC_DIR = path.join(process.cwd(), 'src', 'services');
const abs = (p) => require.resolve(path.join(SVC_DIR, p));

let calls;
function resetCalls() { calls = { uploadToContainer: [], shelfInsert: [], trainingInsert: [] }; }
function installStubs({ existingHash = null, hashInThisChannel = null } = {}) {
  const stub = (relPath, exports) => { const id = abs(relPath); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  stub('./shelfPhotoQualityService', { validateQualityMetrics: async () => ({ accepted: true, hash: 'a'.repeat(64), metrics: { width: 1200, height: 900, sharpness: 0.9, brightness: 0.5 } }) });
  stub('./azureVisionService', { analyzeCaption: async () => ({ stub: true, confidence: 1 }), isShelf: async () => ({ stub: true, isShelf: true }) });
  stub('./customVisionService', { createImageFromData: async () => ({ cvImageId: 'cv-stub-123' }) });
  stub('./blobStorageService', { uploadToContainer: async (args) => { calls.uploadToContainer.push(args); return { url: `https://x.blob.core.windows.net/global-shelf-training/${args.blobPath}`, mode: 'azure' }; } });
  stub('../utils/imageHasher', { hashBuffer: () => 'a'.repeat(64) });
  stub('../utils/shelfPhotoFilenameGenerator', { generateFilename: ({ categoriaSlug, canal }) => `${categoriaSlug}-${canal}-fixedname.jpg` });
  stub('../utils/categoryNameNormalizer', { normalizeName: (s) => s.toLowerCase().replace(/\s+/g, '-') });
  stub('../repositories/categoryRepo', { findById: async () => ({ Category_dsc: 'Desodorantes Corporales', is_smart_dtc: 1 }) });
  stub('../repositories/shelfPhotoRepo', { findByHashGlobal: async () => existingHash, insert: async (row) => { calls.shelfInsert.push(row); return { Photo_id: 999 }; } });
  stub('../repositories/trainingPhotoRepo', { findByHashAndCanal: async () => hashInThisChannel, insert: async (row) => { calls.trainingInsert.push(row); return { photo_id: 1000 }; }, countValidatedApprovedByCategoryChannel: async () => 0 });
  stub('../repositories/aiModelRepo', { findByCategoryId: async () => null, updateStatus: async () => {} });
}
function loadServiceFresh() { delete require.cache[abs('./shelfPhotoUploadService')]; return require(abs('./shelfPhotoUploadService')); }

test('imagen nueva → sube el blob y blob_path coincide con el canal', async () => {
  resetCalls(); installStubs({ existingHash: null });
  const { uploadShelfPhoto } = loadServiceFresh();
  const res = await uploadShelfPhoto({ buffer: Buffer.from('x'), dtcCategoryId: 42, canal: 'OMT', uploadedBy: 44, enterpriseId: 35 });
  assert.equal(calls.uploadToContainer.length, 1);
  assert.match(res.blobPath, /\/omt\//);
  assert.match(calls.trainingInsert[0].blob_path, /\/omt\//);
});
test('hash ya existe en DTT, ahora se sube a OMT → SIEMPRE sube el blob y blob_path=OMT', async () => {
  resetCalls();
  installStubs({ existingHash: { Photo_id: 7, URL_blob: 'https://x.blob.core.windows.net/global-shelf-training/dtc-desodorantes-corporales/dtt/old.jpg' }, hashInThisChannel: null });
  const { uploadShelfPhoto } = loadServiceFresh();
  const res = await uploadShelfPhoto({ buffer: Buffer.from('x'), dtcCategoryId: 42, canal: 'OMT', uploadedBy: 44, enterpriseId: 35 });
  assert.equal(calls.uploadToContainer.length, 1, 'debe subir el blob aunque el hash exista en otro canal');
  assert.match(res.blobPath, /\/omt\//);
  assert.match(calls.trainingInsert[0].blob_path, /\/omt\//);
  assert.equal(calls.shelfInsert.length, 0, 'no re-inserta en RETSC_EX_SHELFPHOTO');
});
test('duplicado exacto en el MISMO canal sigue dando 409', async () => {
  resetCalls();
  installStubs({ existingHash: { Photo_id: 7, URL_blob: 'https://x/global-shelf-training/dtc-desodorantes-corporales/omt/old.jpg' }, hashInThisChannel: { photo_id: 55 } });
  const { uploadShelfPhoto } = loadServiceFresh();
  await assert.rejects(
    () => uploadShelfPhoto({ buffer: Buffer.from('x'), dtcCategoryId: 42, canal: 'OMT', uploadedBy: 44, enterpriseId: 35 }),
    (err) => err.statusCode === 409 && err.errorCode === 'ERR_DUPLICATE_IMAGE'
  );
  assert.equal(calls.uploadToContainer.length, 0);
});
