// Parsea nombres de archivo de imágenes de SKU.
//
// Formato esperado: {EAN}_{vista}.{ext}  o  {EAN}.{ext}
// Ejemplos:
//   '7501234567890_front.jpg'  → { ean: '7501234567890', view: 'front', ext: 'jpg' }
//   '7501234567890.png'        → { ean: '7501234567890', view: 'front', ext: 'png' }
//   '7501234567890_back.WEBP'  → { ean: '7501234567890', view: 'back',  ext: 'webp' }
//
// Retorna null si el filename no cumple las reglas.

const path = require('path');

const VALID_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
// Longitudes válidas de EAN/GTIN
const VALID_EAN_LENGTHS = new Set([8, 12, 13, 14]);

// Normaliza 'jpeg' → 'jpg' para consistencia en los nombres generados.
function normalizeExt(ext) {
  return ext === 'jpeg' ? 'jpg' : ext;
}

function parseFilename(filename) {
  const basename = path.basename(filename);

  // Formato: {digits}[_{view}].{ext}
  const match = basename.match(/^(\d+)(?:_([^.]+))?\.([a-zA-Z]+)$/);
  if (!match) return null;

  const [, ean, viewRaw, extRaw] = match;
  const ext = extRaw.toLowerCase();

  if (!VALID_EAN_LENGTHS.has(ean.length)) return null;
  if (!VALID_EXTS.has(ext)) return null;

  const view = viewRaw ? viewRaw.toLowerCase() : 'front';

  return { ean, view, ext: normalizeExt(ext) };
}

module.exports = { parseFilename };

// ─── Tests unitarios ──────────────────────────────────────────────────────────
if (require.main === module) {
  const tests = [
    { input: '7501234567890_front.jpg',       expect: { ean: '7501234567890', view: 'front', ext: 'jpg' } },
    { input: '7501234567890.png',             expect: { ean: '7501234567890', view: 'front', ext: 'png' } },
    { input: '7501234567890_back.WEBP',       expect: { ean: '7501234567890', view: 'back',  ext: 'webp' } },
    { input: '7501234567890_front.jpeg',      expect: { ean: '7501234567890', view: 'front', ext: 'jpg' } }, // jpeg→jpg
    { input: '12345678_top.png',              expect: { ean: '12345678',      view: 'top',   ext: 'png' } }, // EAN-8
    { input: '7501234567890_FRONT.jpg',       expect: { ean: '7501234567890', view: 'front', ext: 'jpg' } }, // vista uppercase
    { input: 'invalido.jpg',                  expect: null },
    { input: '750123456789012345_front.jpg',  expect: null }, // EAN demasiado largo
    { input: '7501234567890_front.bmp',       expect: null }, // ext no soportada
    { input: 'archivo-malo.txt',              expect: null },
  ];

  let passed = 0;
  for (const { input, expect } of tests) {
    const result = parseFilename(input);
    const ok = JSON.stringify(result) === JSON.stringify(expect);
    console.log(`${ok ? '✓' : '✗'} '${input}' → ${JSON.stringify(result)}`);
    if (!ok) console.log(`   esperado: ${JSON.stringify(expect)}`);
    if (ok) passed++;
  }
  console.log(`\n${passed}/${tests.length} tests pasaron`);
}
