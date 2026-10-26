// Ciclo 5 (A1): Custom Vision acepta máx. 6 MB por imagen. prepareForCustomVision() reduce la
// copia que va a CV y deja pasar intactas las que ya cumplen.
// Usa sharp real (genera una imagen de ruido de ~30 MB). Correr:
//   node src/services/__tests__/customVisionImagePrep.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { prepareForCustomVision, CV_MAX_IMAGE_BYTES } =
  require(path.join(process.cwd(), 'src', 'utils', 'customVisionImagePrep.js'));

function noise(w, h) {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (Math.random() * 256) | 0;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } });
}

test('imagen > 6 MB → se reduce por debajo del límite, misma proporción y misma orientación EXIF', async () => {
  const W = 6000, H = 4500;
  const big = await noise(W, H).withMetadata({ orientation: 6 }).jpeg({ quality: 98 }).toBuffer();
  assert.ok(big.length > CV_MAX_IMAGE_BYTES, 'la imagen de prueba debe pasar de 6 MB');

  const r = await prepareForCustomVision(big);
  const m = await sharp(r.buffer).metadata();

  assert.equal(r.resized, true);
  assert.ok(r.finalBytes <= CV_MAX_IMAGE_BYTES);
  assert.ok(Math.abs(m.width / m.height - W / H) < 0.001, 'la proporción no cambia → las cajitas 0..1 siguen válidas');
  assert.equal(m.orientation, 6, 'conserva la orientación EXIF');
});

test('imagen ≤ 6 MB → pasa intacta (mismo buffer)', async () => {
  const small = await noise(800, 600).jpeg().toBuffer();
  const r = await prepareForCustomVision(small);
  assert.equal(r.resized, false);
  assert.equal(r.buffer, small);
});
