// Filtra cajitas espurias que Custom Vision genera sobre franjas parciales de un producto
// (hallazgo de María Royo, 2026-09-25, email "RESULTADOS"): el modelo aprendió a marcar la
// banda superior oscura de algunos Nivea Men (Deep, Silver Protect) como si fuera un
// producto aparte, además de marcar el envase completo — el mismo producto termina
// generando DOS detecciones. La cajita espuria siempre sale con ocr_text vacío/Sku_id NULL
// (nunca aporta una identificación, solo infla el denominador del % de identificación y
// cuesta ~800ms de OCR cada una).
//
// La separación es limpísima en datos reales (validado dos veces: el dataset original de
// María y, de forma independiente, Photo_id=61/visita 59 de este repo — mismo resultado,
// 23 conservadas / 7 descartadas):
//   - Productos legítimos (envase completo, tapa a base): proporción alto/ancho ~4.2–5.2.
//   - Cajitas espurias (solo la tapa/banda): proporción ~1.0–1.8 (casi cuadradas).
//   - Un caso aparte: una franja vertical delgada entre dos productos puede salir con
//     proporción muy alta (~14) — igual de espuria, por el lado opuesto.
// Un umbral [3.0, 8.0] separa ambos grupos sin zona gris — más simple y más confiable que
// supresión por solapamiento (NMS): la cajita espuria puede quedar apenas ARRIBA del
// producto en vez de adentro, con lo cual un criterio de IoU/contención no la atrapa.
//
// ⚠ Los umbrales 3.0/8.0 están calibrados para envases de desodorante (altos y angostos).
// Otra categoría (cajas, cremas anchas y bajas) va a necesitar otros valores — recalibrar
// por categoría antes de extender esto más allá de Desodorantes Corporales.
const MIN_RATIO = 3.0;
const MAX_RATIO = 8.0;

/**
 * @param {Array} detecciones  filas ya mapeadas al formato de RETSC_EX_SHELFPHOTO_DETECTION
 *   (bbox_left/bbox_top/bbox_width/bbox_height/confidence/...), YA filtradas por umbral de
 *   confianza — esto filtra por FORMA, es un paso aparte.
 * @returns {{ conservadas: Array, descartadas: Array, resumen: object }}
 *   descartadas trae la fila original + `proporcion` + `motivo`, para poder auditar en la
 *   primera corrida qué se está tirando antes de confiar ciegamente en el filtro.
 */
function filtrarDetecciones(detecciones) {
  const conservadas = [];
  const descartadas = [];

  for (const d of detecciones) {
    const proporcion = d.bbox_height / d.bbox_width;
    const esEspuria = proporcion < MIN_RATIO || proporcion > MAX_RATIO;

    if (esEspuria) {
      descartadas.push({
        ...d,
        proporcion,
        motivo: proporcion < MIN_RATIO ? 'MUY_APLANADA' : 'MUY_ANGOSTA',
      });
    } else {
      conservadas.push(d);
    }
  }

  return {
    conservadas,
    descartadas,
    resumen: {
      entrada: detecciones.length,
      descartadas_por_forma: descartadas.length,
      conservadas: conservadas.length,
    },
  };
}

module.exports = { filtrarDetecciones };
