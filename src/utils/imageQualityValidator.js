// Validador de calidad de fotos de góndola para el dataset de entrenamiento (Issue 7.1).
//
// Mide 3 criterios sobre los píxeles de la imagen y devuelve los códigos de error
// del issue. El 4º criterio (DUPLICATE_IMAGE) NO vive aquí porque requiere consultar
// la BD; se resuelve en src/services/shelfPhotoQualityService.js usando el hash.
//
// Criterios (Issue 7.1):
//   Resolución  >= 1280x720      → LOW_RESOLUTION
//   Nitidez     score > 0.6      → BLURRY_IMAGE   (score normalizado [0,1])
//   Iluminación brillo en 30-220 → POOR_LIGHTING  (brillo medio sobre 0-255)
//
// Dependencia externa: sharp (decodifica la imagen y expone metadata + píxeles raw).
//
// Umbrales configurables por .env (defaults = valores del issue):
//   QUALITY_MIN_WIDTH=1280   QUALITY_MIN_HEIGHT=720
//   QUALITY_MIN_SHARPNESS=0.6
//   QUALITY_MIN_BRIGHTNESS=30   QUALITY_MAX_BRIGHTNESS=220
//   QUALITY_SHARPNESS_NORM=1000   (divisor de normalización de la varianza Laplaciana)
//
// NOTA: el umbral de nitidez 0.6 y el divisor QUALITY_SHARPNESS_NORM deben calibrarse
// con fotos reales de góndola (buenas y borrosas). La varianza del Laplaciano no viene
// en [0,1]; se normaliza dividiendo por QUALITY_SHARPNESS_NORM y se satura en 1.
// La migración 005 persiste blur_score y brightness justamente para poder calibrar
// estos valores con datos de producción.
//
// NOTA: la convolución de sharp recorta su salida a 0-255 (uint8), lo que pierde parte
// de la señal del Laplaciano. Es una aproximación suficiente como medida RELATIVA de
// nitidez para filtrar borrosas; no es un valor físico absoluto.

const fs = require('fs').promises;
const sharp = require('sharp');

// Kernel Laplaciano 3x3 para detección de bordes (base de la métrica de nitidez).
const LAPLACIAN_KERNEL = { width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] };

function num(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}

// Se leen en cada llamada (no al importar) para que distintos entornos y los
// self-tests puedan sobreescribir vía process.env u opts sin reimportar el módulo.
function thresholds() {
  return {
    minWidth:      num('QUALITY_MIN_WIDTH', 1280),
    minHeight:     num('QUALITY_MIN_HEIGHT', 720),
    minSharpness:  num('QUALITY_MIN_SHARPNESS', 0.6),
    minBrightness: num('QUALITY_MIN_BRIGHTNESS', 30),
    maxBrightness: num('QUALITY_MAX_BRIGHTNESS', 220),
    sharpnessNorm: num('QUALITY_SHARPNESS_NORM', 1000),
  };
}

// Acepta ruta (string) o Buffer; lee a memoria una sola vez para no releer disco
// en cada paso de sharp.
async function toBuffer(input) {
  return typeof input === 'string' ? fs.readFile(input) : input;
}

// Brillo medio (0-255) sobre la imagen en escala de grises.
function meanBrightness(grayData) {
  if (!grayData.length) return 0;
  let sum = 0;
  for (let i = 0; i < grayData.length; i++) sum += grayData[i];
  return sum / grayData.length;
}

// Nitidez = varianza de la respuesta del Laplaciano, normalizada a [0,1].
// Más alto = más nítido. Devuelve también la varianza cruda para auditoría.
async function sharpness(buffer, norm) {
  const { data } = await sharp(buffer)
    .greyscale()
    .convolve(LAPLACIAN_KERNEL)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    sumSq += data[i] * data[i];
  }
  const mean = sum / data.length;
  const variance = sumSq / data.length - mean * mean;
  return { score: Math.min(variance / norm, 1), variance };
}

// Valida los 3 criterios de píxeles de una imagen.
// Devuelve { valid, errors[], metrics } — errors puede traer varios códigos.
async function validateImageQuality(input, opts = {}) {
  const t = { ...thresholds(), ...opts };
  const buffer = await toBuffer(input);
  const errors = [];
  const metrics = { width: null, height: null, brightness: null, sharpness: null, variance: null };

  // Criterio 1: resolución (lee solo metadata, sin decodificar todos los píxeles)
  const meta = await sharp(buffer).metadata();
  metrics.width = meta.width ?? null;
  metrics.height = meta.height ?? null;
  if (!metrics.width || !metrics.height ||
      metrics.width < t.minWidth || metrics.height < t.minHeight) {
    errors.push('LOW_RESOLUTION');
  }

  // Decodifica a escala de grises (raw, 1 canal) para brillo y nitidez.
  const { data: gray } = await sharp(buffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Criterio 3: iluminación
  metrics.brightness = meanBrightness(gray);
  if (metrics.brightness < t.minBrightness || metrics.brightness > t.maxBrightness) {
    errors.push('POOR_LIGHTING');
  }

  // Criterio 2: nitidez
  const sh = await sharpness(buffer, t.sharpnessNorm);
  metrics.sharpness = sh.score;
  metrics.variance = sh.variance;
  if (sh.score <= t.minSharpness) {
    errors.push('BLURRY_IMAGE');
  }

  return { valid: errors.length === 0, errors, metrics };
}

module.exports = { validateImageQuality };

// ── auto-test ─────────────────────────────────────────────────────────────────
// Genera imágenes sintéticas en memoria y valida que cada criterio dispare su código.
// Ruido aleatorio = alta frecuencia = nítido; .blur() lo vuelve borroso.
//   node src/utils/imageQualityValidator.js
if (require.main === module) {
  (async () => {
    // Imagen de ruido RGB: scale/offset controlan el rango de intensidad (brillo).
    async function noise(w, h, scale = 255, offset = 0) {
      const buf = Buffer.alloc(w * h * 3);
      for (let i = 0; i < buf.length; i++) buf[i] = offset + Math.floor(Math.random() * scale);
      return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    }

    const good   = await noise(1280, 720);                 // nítida, brillo medio, resol. OK
    const lowRes = await noise(640, 480);                  // resolución insuficiente
    const dark   = await noise(1280, 720, 20, 0);          // brillo ~10 → oscura
    const bright = await noise(1280, 720, 20, 235);        // brillo ~245 → quemada
    const blurry = await sharp(await noise(1280, 720)).blur(15).png().toBuffer(); // borrosa

    const cases = [
      { name: 'good (1280x720 nítida)', img: good,   expectValid: true,  expectCode: null },
      { name: 'baja resolución',        img: lowRes, expectValid: false, expectCode: 'LOW_RESOLUTION' },
      { name: 'oscura',                 img: dark,   expectValid: false, expectCode: 'POOR_LIGHTING' },
      { name: 'sobreexpuesta',          img: bright, expectValid: false, expectCode: 'POOR_LIGHTING' },
      { name: 'borrosa',                img: blurry, expectValid: false, expectCode: 'BLURRY_IMAGE' },
    ];

    let passed = 0;
    for (const c of cases) {
      const r = await validateImageQuality(c.img);
      const ok = r.valid === c.expectValid &&
                 (c.expectCode === null ? r.errors.length === 0 : r.errors.includes(c.expectCode));
      const m = r.metrics;
      console.log(
        `${ok ? '✓' : '✗'} ${c.name.padEnd(26)} ` +
        `valid=${r.valid} errors=[${r.errors.join(',')}] ` +
        `(${m.width}x${m.height}, bright=${m.brightness?.toFixed(1)}, sharp=${m.sharpness?.toFixed(3)})`
      );
      if (ok) passed++;
    }
    console.log(`\n${passed}/${cases.length} tests pasaron`);
    process.exit(passed === cases.length ? 0 : 1);
  })().catch((err) => { console.error(err); process.exit(1); });
}
