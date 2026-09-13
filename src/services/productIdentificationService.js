// Paso 5 de la guía "Fotos de Visita" v1.9 (sección 7.1) — identifica QUÉ producto es cada
// cajita ya detectada. La idea general (sección 7.1, punto 1-2, es responsabilidad de este
// archivo — Daniel): recorta la imagen original según la cajita, le hace OCR al recorte.
// Los puntos 3-4 (texto → embedding → búsqueda en retsc-sku-vectors, y el UPDATE final) los
// resuelve buscarSkuPorTexto() (skuSearchService.js) + shelfPhotoDetectionRepo.updateIdentifications().
//
// 2026-09-04 — este archivo llamaba a azureVisionService.readText() (STUB, siempre texto
// vacío) y a skuIdentificationService.buscarSkuPorTexto() (PLACEHOLDER, siempre matched:false)
// — el pipeline corría automáticamente en cada foto (ver detectionPipelineService.js) pero
// nunca identificaba nada, en silencio. Redirigido a las implementaciones reales:
// visionOcrService.runOcr() (Azure AI Vision de verdad) y skuSearchService.buscarSkuPorTexto()
// (embeddings + Azure AI Search de verdad, umbral en RETSC_CONFIG.SKU_MATCH_THRESHOLD).
// Ambas degradan solas (sin lanzar) si faltan credenciales (AZURE_VISION_*/AZURE_SEARCH_*/
// AZURE_OPENAI_* en .env, hoy vacías) — mismo comportamiento de "sin match" que antes, pero
// ahora por falta real de configuración, no por un stub que finge éxito.
//
// ocr_text se guarda SIEMPRE, haya o no match — es lo que alimenta la vista de "productos
// no identificados" del dashboard web (guía sección 8.4).

const sharp                   = require('sharp');
const { cropRegion }          = require('../utils/imageCropper');
const visionOcrService        = require('./visionOcrService');
const skuSearchService        = require('./skuSearchService');
const shelfPhotoDetectionRepo = require('../repositories/shelfPhotoDetectionRepo');

// detections: filas de RETSC_EX_SHELFPHOTO_DETECTION recién insertadas (con Detection_id y
// las coordenadas Bbox_*). buffer: la foto completa (mismo buffer ya subido a Blob en el
// Paso 1 — no hace falta volver a descargarlo).
//
// No lanza si una cajita individual falla el recorte/OCR — la deja sin identificar (ocr_text
// vacío) y sigue con las demás; una sola cajita rara no debe tumbar la identificación de
// toda la foto.
async function identifyDetections(buffer, detections) {
  if (!detections || detections.length === 0) return [];

  // EXIF: las fotos de celular (iPhone en particular) traen la orientación real en un
  // metadato, no rotada en los píxeles crudos. Custom Vision interpreta esa orientación al
  // analizar (sus cajitas son relativas a la imagen YA orientada para mostrarse) — si acá se
  // recorta contra los píxeles crudos sin rotar, los recortes salen de la parte equivocada
  // de la góndola, y son recortes VÁLIDOS (no tiran error), solo que del lugar incorrecto.
  // sharp().rotate() sin argumentos normaliza usando ese metadato — se hace UNA sola vez acá
  // (no adentro de cropRegion, que se llama una vez por cajita) y las demás cajitas recortan
  // contra este mismo buffer ya normalizado.
  const normalizedBuffer = await sharp(buffer).rotate().jpeg().toBuffer();

  const ocrResults = await Promise.all(detections.map(async (d) => {
    try {
      const crop = await cropRegion(normalizedBuffer, {
        left:   d.Bbox_left,
        top:    d.Bbox_top,
        width:  d.Bbox_width,
        height: d.Bbox_height,
      });
      const { text } = await visionOcrService.runOcr(crop);
      return text ?? '';
    } catch (err) {
      console.warn(`[productIdentification] no se pudo recortar/OCR Detection_id=${d.Detection_id} — ${err.message}`);
      return '';
    }
  }));

  // buscarSkuPorTexto acepta arreglos completos a propósito (guía sección 7.2: "al cerrar
  // una visita puede haber muchas cajitas de golpe, llamar una por una sería lento y caro").
  // Envuelto en try/catch como defensa adicional (además del fix en skuSearchService.js):
  // un fallo acá NUNCA debe tumbar la identificación de toda la foto, solo dejarla sin SKU.
  let matches;
  try {
    matches = await skuSearchService.buscarSkuPorTexto(ocrResults);
  } catch (err) {
    console.error(`[productIdentification] buscarSkuPorTexto falló para las ${ocrResults.length} cajita(s) de esta foto — todas quedan sin SKU:`, err.message);
    matches = ocrResults.map((texto) => ({ sku_id: null, matched: false, texto_original: texto }));
  }

  const resultados = detections.map((d, i) => {
    const match = matches[i] ?? { sku_id: null, matched: false, texto_original: ocrResults[i] };
    return {
      detectionId: d.Detection_id,
      skuId:       match.matched ? match.sku_id : null,
      ocrText:     match.texto_original ?? ocrResults[i],
    };
  });

  // Un solo UPDATE...FROM en vez de N updates sueltos — ver shelfPhotoDetectionRepo.js.
  return shelfPhotoDetectionRepo.updateIdentifications(resultados);
}

module.exports = { identifyDetections };
