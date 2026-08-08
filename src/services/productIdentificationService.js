// Paso 5 de la guía "Fotos de Visita" v1.9 (sección 7.1) — identifica QUÉ producto es cada
// cajita ya detectada. La idea general (sección 7.1, punto 1-2, es responsabilidad de este
// archivo — Daniel): recorta la imagen original según la cajita, le hace OCR al recorte.
// Los puntos 3-4 (texto → embedding → búsqueda en retsc-sku-vectors, y el UPDATE final) los
// resuelve buscarSkuPorTexto() (skuIdentificationService.js) + shelfPhotoDetectionRepo — ese
// módulo es de Joel, no de este archivo (ver su propio header).
//
// ocr_text se guarda SIEMPRE, haya o no match — es lo que alimenta la vista de "productos
// no identificados" del dashboard web (guía sección 8.4).

const { cropRegion }         = require('../utils/imageCropper');
const azureVisionService     = require('./azureVisionService');
const skuIdentificationService = require('./skuIdentificationService');
const shelfPhotoDetectionRepo  = require('../repositories/shelfPhotoDetectionRepo');

// detections: filas de RETSC_EX_SHELFPHOTO_DETECTION recién insertadas (con Detection_id y
// las coordenadas Bbox_*). buffer: la foto completa (mismo buffer ya subido a Blob en el
// Paso 1 — no hace falta volver a descargarlo).
//
// No lanza si una cajita individual falla el recorte/OCR — la deja sin identificar (ocr_text
// vacío) y sigue con las demás; una sola cajita rara no debe tumbar la identificación de
// toda la foto.
async function identifyDetections(buffer, detections) {
  if (!detections || detections.length === 0) return [];

  const ocrResults = await Promise.all(detections.map(async (d) => {
    try {
      const crop = await cropRegion(buffer, {
        left:   d.Bbox_left,
        top:    d.Bbox_top,
        width:  d.Bbox_width,
        height: d.Bbox_height,
      });
      const { text } = await azureVisionService.readText(crop);
      return text ?? '';
    } catch (err) {
      console.warn(`[productIdentification] no se pudo recortar/OCR Detection_id=${d.Detection_id} — ${err.message}`);
      return '';
    }
  }));

  // buscarSkuPorTexto acepta arreglos completos a propósito (guía sección 7.2: "al cerrar
  // una visita puede haber muchas cajitas de golpe, llamar una por una sería lento y caro").
  const matches = await skuIdentificationService.buscarSkuPorTexto(ocrResults);

  const updated = [];
  for (let i = 0; i < detections.length; i++) {
    const detection = detections[i];
    const match = matches[i] ?? { sku_id: null, matched: false, texto_original: ocrResults[i] };

    const row = await shelfPhotoDetectionRepo.updateIdentification(detection.Detection_id, {
      skuId:   match.matched ? match.sku_id : null,
      ocrText: match.texto_original ?? ocrResults[i],
    });
    updated.push(row);
  }

  return updated;
}

module.exports = { identifyDetections };
