// Recorta una región normalizada [0,1] (left/top/width/height) de una imagen.
//
// Usado en el Paso 5 de la guía "Fotos de Visita" v1.9 (sección 7.1, punto 1: "se recorta
// la imagen original según las coordenadas de cada cajita detectada") antes de mandar cada
// recorte a OCR (azureVisionService.readText()).
//
// Mismo formato de coordenadas que ya usa el resto del repo para bounding boxes
// (annotationRepo.js, customVisionService.js): normalizadas 0..1, no píxeles.
//
// TODOs conocidos: ninguno.

const sharp = require('sharp');

// region: { left, top, width, height } normalizados [0,1] respecto a la imagen original.
// Devuelve un Buffer JPEG con el recorte.
async function cropRegion(buffer, region) {
  const image = sharp(buffer);
  const { width: imgWidth, height: imgHeight } = await image.metadata();

  // Convierte normalizado → píxeles, y recorta contra los bordes de la imagen (Custom
  // Vision puede devolver cajitas cuyo left+width se pase levemente de 1.0 por redondeo).
  const left   = Math.max(0, Math.round(region.left   * imgWidth));
  const top    = Math.max(0, Math.round(region.top    * imgHeight));
  const width  = Math.min(imgWidth  - left, Math.round(region.width  * imgWidth));
  const height = Math.min(imgHeight - top,  Math.round(region.height * imgHeight));

  if (width <= 0 || height <= 0) {
    throw Object.assign(
      new Error(`Región de recorte inválida (left=${left}, top=${top}, width=${width}, height=${height}) para imagen ${imgWidth}x${imgHeight}.`),
      { statusCode: 422 }
    );
  }

  return image.extract({ left, top, width, height }).jpeg().toBuffer();
}

module.exports = { cropRegion };
