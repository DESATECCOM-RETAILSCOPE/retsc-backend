// Prueba de regresión del fix de fallo parcial de batch en createImageRegions (Fase 2, F1.1).
//
// Bug: createImageRegions trocea en lotes de 64 (límite real de la API de Custom Vision) vía
// llamadas HTTP INDEPENDIENTES — sin atomicidad entre lotes del lado de CV. Si una foto tiene
// más de 64 cajitas y el SEGUNDO lote falla, antes la excepción se propagaba sin llevar lo que
// el PRIMER lote ya había confirmado — esas regiones, ya reales en Custom Vision, se perdían
// de la vista del llamador. Este test aísla customVisionService.createImageRegions (mockeando
// solo `fetch` global, no todo el módulo) para probar el comportamiento real de chunking.
//
// Correr: node src/services/__tests__/customVisionRegions.regression.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

process.env.CUSTOM_VISION_ENDPOINT = 'https://fake-cv-endpoint.cognitiveservices.azure.com';
process.env.CUSTOM_VISION_TRAINING_KEY = 'fake-key';

function fakeRegion(i) {
  return { imageId: 'img-1', tagId: 'tag-1', left: i / 1000, top: 0.1, width: 0.05, height: 0.05 };
}

function fakeResponse(status, bodyObj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(bodyObj),
  };
}

function loadServiceFresh() {
  const id = require.resolve(path.join(process.cwd(), 'src', 'services', 'customVisionService.js'));
  delete require.cache[id];
  return require(id);
}

test('lote 2 falla → el error lanzado lleva partialCreated con lo confirmado en el lote 1, y onBatchCreated ya se llamó para ese lote', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let batchesNotified = [];

  global.fetch = async (_url, _opts) => {
    calls.push(1);
    if (calls.length === 1) {
      // Lote 1 (64 regiones) — Custom Vision confirma todas.
      return fakeResponse(200, { created: Array.from({ length: 64 }, (_, i) => ({ regionId: `region-${i}`, ...fakeRegion(i) })) });
    }
    // Lote 2 (las 6 restantes) — Custom Vision rechaza.
    return fakeResponse(400, { code: 'BadRequestDetectionTrainingValidationFailed', message: 'algo falló' });
  };

  try {
    const customVisionService = loadServiceFresh();
    const regions = Array.from({ length: 70 }, (_, i) => fakeRegion(i));

    await assert.rejects(
      () => customVisionService.createImageRegions('proj-1', regions, {
        onBatchCreated: async (chunkCreated) => { batchesNotified.push(chunkCreated.length); },
      }),
      (err) => {
        assert.equal(err.partialCreated?.length, 64, 'el error debe llevar las 64 regiones confirmadas en el lote 1');
        return true;
      }
    );

    assert.equal(calls.length, 2, 'debe haber intentado exactamente 2 lotes (64 + 6)');
    assert.deepEqual(batchesNotified, [64], 'onBatchCreated debe haberse llamado UNA vez, con las 64 del lote 1, ANTES de que el lote 2 fallara');
  } finally {
    global.fetch = originalFetch;
  }
});

test('todo confirma en un solo lote (<=64) → onBatchCreated se llama una vez con todo, sin error', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeResponse(200, { created: Array.from({ length: 10 }, (_, i) => ({ regionId: `region-${i}`, ...fakeRegion(i) })) });

  try {
    const customVisionService = loadServiceFresh();
    const regions = Array.from({ length: 10 }, (_, i) => fakeRegion(i));
    const notified = [];

    const created = await customVisionService.createImageRegions('proj-1', regions, {
      onBatchCreated: async (chunkCreated) => notified.push(chunkCreated.length),
    });

    assert.equal(created.length, 10);
    assert.deepEqual(notified, [10]);
  } finally {
    global.fetch = originalFetch;
  }
});
