// Servicio de validación de calidad de imagen (Issue 6.1).
// Compuerta barata y local — se ejecuta ANTES de llamadas costosas a Azure (OCR, embeddings).
//
// Este servicio es PURO: no toca la BD ni decide el flujo.
// El controller/orquestador (6.4) es quien persiste el resultado.
//
// Criterios validados (en orden de prioridad):
//   1. LOW_RESOLUTION — imagen menor a minWidth × minHeight px
//   2. BLURRY         — varianza del Laplaciano por debajo de minSharpness
//   3. POOR_LIGHTING  — brillo promedio fuera del rango [minBrightness, maxBrightness]
//
// Si falla por más de un criterio, se registra el PRIMERO en ese orden.
// Todos los fallos se devuelven en el campo `failures` para el log.
//
// TODO: calibrar umbrales con imágenes reales de producto (con María).

const { analyzeImage } = require('../utils/imageQualityAnalyzer');

// OPTIMIZAR: ajustar estos valores una vez se dispongan imágenes de referencia calibradas.
const QUALITY_THRESHOLDS = {
  minWidth:  800,
  minHeight: 800,
  // Nitidez: varianza del Laplaciano. Valores típicos: <100 muy borroso, >100 nítido.
  // El issue menciona "blur > 0.5" pero esa escala no aplica a varianza de Laplaciano.
  // Usamos un umbral empírico ajustable. TODO: calibrar con imágenes reales.
  minSharpness: 100,
  // Brillo medio (0-255). Rango aceptable: ni muy oscura ni quemada.
  minBrightness: 40,
  maxBrightness: 220,
};

/**
 * Valida la calidad de una imagen local sin tocar la BD.
 *
 * @param {string} filePath  Ruta absoluta al archivo de imagen en disco.
 * @returns {{ status: string, metrics: object, failures: string[] }}
 *   - status:   'VALID' | 'LOW_RESOLUTION' | 'BLURRY' | 'POOR_LIGHTING'
 *   - metrics:  { width, height, sharpness, brightness }
 *   - failures: todos los criterios que fallaron (para log de detalle)
 */
const validateImage = async (filePath) => {
  const metrics  = await analyzeImage(filePath);
  const failures = [];

  if (metrics.width < QUALITY_THRESHOLDS.minWidth || metrics.height < QUALITY_THRESHOLDS.minHeight) {
    failures.push('LOW_RESOLUTION');
  }
  if (metrics.sharpness < QUALITY_THRESHOLDS.minSharpness) {
    failures.push('BLURRY');
  }
  if (metrics.brightness < QUALITY_THRESHOLDS.minBrightness || metrics.brightness > QUALITY_THRESHOLDS.maxBrightness) {
    failures.push('POOR_LIGHTING');
  }

  // El status es el primer fallo en orden res → blur → brillo; VALID si ninguno.
  const status = failures.length === 0 ? 'VALID' : failures[0];

  return { status, metrics, failures };
};

module.exports = { validateImage, QUALITY_THRESHOLDS };
