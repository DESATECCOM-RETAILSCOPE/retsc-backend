// Reemplaza detectionFilter.js (filtro por aspect ratio, desactivado 2026-09-28 — ver
// customVisionPredictService.js) como forma de descartar las cajitas espurias que Custom
// Vision genera sobre una franja parcial de un producto (tapa, banda superior, recorte del
// label) además de la cajita del producto completo.
//
// El filtro por proporción width/height fallaba porque dependía de la FORMA del producto
// (una lata alta se parece a una cajita espuria "aplanada" de un stick, y viceversa) — no
// hay un único rango de proporción que separe ambos casos para todos los formatos de
// producto de una categoría (ver el comentario de por qué se desactivó en
// customVisionPredictService.js, caso real: Photo_id=89/visita 67).
//
// Señal más confiable, ya disponible en el pipeline sin costo adicional: una cajita espuria
// (tapa/banda parcial) NUNCA logra identificarse por OCR+SKU (no tiene texto de marca
// legible propio) y SIEMPRE está geométricamente contenida dentro de la cajita del producto
// completo que sí se identifica. Validado visualmente contra Photo_id=89 (visita 67,
// 2026-09-28): de 30 detecciones, las únicas con >75% de su área contenida en otra
// detección con SKU identificado eran, en los 3 casos, recortes de tapa/label parcial sobre
// una lata AXE — separación limpia contra el resto (todos <40% de contención).
const CONTAINMENT_THRESHOLD = 0.6;

function area(d) {
  return d.Bbox_width * d.Bbox_height;
}

// Área de intersección entre dos cajitas (coordenadas normalizadas 0-1, mismo sistema que
// usa Custom Vision — ver detectionFilter.js para el mismo tipo de cálculo geométrico).
function interseccion(a, b) {
  const left   = Math.max(a.Bbox_left, b.Bbox_left);
  const top    = Math.max(a.Bbox_top,  b.Bbox_top);
  const right  = Math.min(a.Bbox_left + a.Bbox_width,  b.Bbox_left + b.Bbox_width);
  const bottom = Math.min(a.Bbox_top  + a.Bbox_height, b.Bbox_top  + b.Bbox_height);
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  return w * h;
}

/**
 * @param {Array} detections  filas de RETSC_EX_SHELFPHOTO_DETECTION YA identificadas (Paso
 *   5 — con Sku_id poblado o NULL), con Detection_id/Bbox_left/Bbox_top/Bbox_width/Bbox_height.
 * @returns {{ conservadas: Array, duplicadas: Array }} duplicadas trae la fila original —
 *   quien llame decide qué hacer con ellas (ver detectionPipelineService.js: se borran de
 *   RETSC_EX_SHELFPHOTO_DETECTION, nunca se insertaron en el filtro anterior tampoco).
 */
function filtrarDuplicadosContenidos(detections) {
  const identificadas = detections.filter((d) => d.Sku_id != null);
  const conservadas = [];
  const duplicadas = [];

  for (const d of detections) {
    if (d.Sku_id != null) {
      conservadas.push(d);
      continue;
    }

    const esDuplicada = identificadas.some((otra) => {
      if (otra.Detection_id === d.Detection_id) return false;
      return interseccion(d, otra) / area(d) >= CONTAINMENT_THRESHOLD;
    });

    if (esDuplicada) duplicadas.push(d);
    else conservadas.push(d);
  }

  return { conservadas, duplicadas };
}

module.exports = { filtrarDuplicadosContenidos };
