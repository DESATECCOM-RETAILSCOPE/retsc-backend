// Analiza la calidad de una imagen local (path en disco).
// Devuelve: { width, height, sharpness, brightness }
//
// - width/height: dimensiones en px.
// - sharpness: varianza del Laplaciano (mayor = más nítida). Imágenes borrosas → baja varianza;
//   imágenes con bordes definidos → alta varianza. Umbral empírico por defecto: 100.
// - brightness: brillo promedio 0-255 (luminancia ponderada). Umbral empírico: 40-220.
//
// Implementación:
//   - Se usa sharp para leer dimensiones y datos crudos de píxeles (raw RGB).
//   - Para nitidez: kernel Laplaciano 3x3 aplicado sobre escala de grises.
//   - Para imágenes grandes se submuestrea 1 de cada SAMPLE_STEP píxeles para agilidad.
//
// TODO: calibrar SAMPLE_STEP y umbrales con imágenes reales de producto.

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

// Cuántos píxeles se saltan entre muestras en el análisis de Laplaciano/brillo.
// Un valor mayor acelera el análisis a costa de precisión.
// Con SAMPLE_STEP=1 se analiza la imagen completa (más lento pero más preciso).
const SAMPLE_STEP = 2;

// Kernel Laplaciano 3x3 estándar para detección de bordes.
const LAPLACIAN_KERNEL = [
  [0,  1, 0],
  [1, -4, 1],
  [0,  1, 0],
];

/**
 * Aplica el kernel Laplaciano a un mapa de grises (array plano, fila por fila).
 * Devuelve la varianza de los valores resultantes (métrica de nitidez).
 */
function computeLaplacianVariance(gray, width, height) {
  const values = [];

  for (let y = 1; y < height - 1; y += SAMPLE_STEP) {
    for (let x = 1; x < width - 1; x += SAMPLE_STEP) {
      let sum = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          sum += gray[(y + ky) * width + (x + kx)] * LAPLACIAN_KERNEL[ky + 1][kx + 1];
        }
      }
      values.push(sum);
    }
  }

  if (values.length === 0) return 0;

  const mean     = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return variance;
}

/**
 * Calcula el brillo promedio (luminancia ponderada 0-255) de un buffer RGB.
 * Fórmula estándar: L = 0.299*R + 0.587*G + 0.114*B
 */
function computeBrightness(rgbBuffer, totalPixels) {
  let sum = 0;
  for (let i = 0; i < totalPixels; i++) {
    const r = rgbBuffer[i * 3];
    const g = rgbBuffer[i * 3 + 1];
    const b = rgbBuffer[i * 3 + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return sum / totalPixels;
}

/**
 * Analiza la calidad de una imagen en disco.
 * Retorna: { width, height, sharpness, brightness }
 */
async function analyzeImage(filePath) {
  const image = sharp(filePath).removeAlpha().toColorspace('srgb');

  const meta     = await image.metadata();
  const { width, height } = meta;

  // Extraer píxeles crudos en RGB (sin alpha)
  const { data: rgbBuffer } = await image
    .raw()
    .toBuffer({ resolveWithObject: true });

  const totalPixels = width * height;

  // Construir mapa de grises: L = 0.299R + 0.587G + 0.114B
  const gray = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    gray[i] = 0.299 * rgbBuffer[i * 3] + 0.587 * rgbBuffer[i * 3 + 1] + 0.114 * rgbBuffer[i * 3 + 2];
  }

  const sharpness  = computeLaplacianVariance(gray, width, height);
  const brightness = computeBrightness(rgbBuffer, totalPixels);

  return {
    width,
    height,
    sharpness:  parseFloat(sharpness.toFixed(2)),
    brightness: parseFloat(brightness.toFixed(2)),
  };
}

module.exports = { analyzeImage };

// ─── Auto-test (node src/utils/imageQualityAnalyzer.js) ──────────────────────
if (require.main === module) {
  const testDir = path.join(__dirname, '..', '..', 'test-data', 'sku-images');

  (async () => {
    const files = fs.readdirSync(testDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    if (files.length === 0) {
      console.log('No se encontraron imágenes en', testDir);
      return;
    }

    console.log('\n=== imageQualityAnalyzer — auto-test ===\n');
    for (const file of files) {
      try {
        const metrics = await analyzeImage(path.join(testDir, file));
        console.log(`${file}`);
        console.log(`  Dimensiones : ${metrics.width} × ${metrics.height} px`);
        console.log(`  Nitidez     : ${metrics.sharpness}  (umbral defecto: 100)`);
        console.log(`  Brillo      : ${metrics.brightness}  (umbral defecto: 40-220)`);
        console.log();
      } catch (err) {
        console.error(`${file}: ERROR — ${err.message}`);
      }
    }
  })();
}
