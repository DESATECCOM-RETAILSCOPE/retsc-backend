// Ciclo 5 (A1) — Preparación de la imagen que se envía a Custom Vision.
//
// Límite de Custom Vision: 6 MB por imagen de entrenamiento. Las fotos de góndola de celulares
// recientes pueden pasarse. Regla del plan: la ORIGINAL se queda intacta en el blob y solo la
// copia que viaja a Custom Vision se comprime/reduce.
//
// Las cajitas (RETSC_AI_TRAINING_ANNOTATIONS.bbox_*) están en coordenadas NORMALIZADAS 0..1,
// así que reducir la imagen manteniendo la proporción no las mueve. Se conserva la metadata
// (incluida la orientación EXIF) para que Custom Vision vea la imagen igual que la original.
//
// sharp se carga de forma diferida: solo hace falta cuando la foto supera el límite (así los
// tests que no tocan este camino no dependen del binario nativo).

const CV_MAX_IMAGE_BYTES = 6 * 1024 * 1024;
// Margen para no quedar justo en el borde del límite.
const TARGET_BYTES = Math.floor(CV_MAX_IMAGE_BYTES * 0.95);

// Devuelve { buffer, resized, originalBytes, finalBytes }. Lanza si no logra bajar del límite.
async function prepareForCustomVision(buffer) {
  const originalBytes = buffer.length;
  if (originalBytes <= CV_MAX_IMAGE_BYTES) {
    return { buffer, resized: false, originalBytes, finalBytes: originalBytes };
  }

  const sharp = require('sharp');
  const { width, height } = await sharp(buffer).metadata();

  // 1.er intento: mismo tamaño, JPEG calidad 85 (suele alcanzar). Después se reduce la
  // resolución proporcionalmente al exceso, hasta 5 intentos.
  let scale = 1;
  let out = buffer;
  for (let attempt = 0; attempt < 6; attempt++) {
    out = await sharp(buffer)
      .resize(Math.round(width * scale), Math.round(height * scale), { fit: 'fill' })
      .withMetadata()
      .jpeg({ quality: attempt === 0 ? 85 : 80, mozjpeg: true })
      .toBuffer();
    if (out.length <= TARGET_BYTES) {
      return { buffer: out, resized: true, originalBytes, finalBytes: out.length };
    }
    scale *= Math.sqrt(TARGET_BYTES / out.length) * 0.95;
  }
  throw new Error(`No se pudo reducir la imagen por debajo de 6 MB (original ${originalBytes} B, último intento ${out.length} B)`);
}

module.exports = { prepareForCustomVision, CV_MAX_IMAGE_BYTES };
