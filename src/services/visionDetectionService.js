// Adaptador para "el endpoint que te da Joel" (guía "Fotos de Visita" v1.9, sección 5.2):
// Daniel NO llama directo a la API de predicción de Custom Vision con sus credenciales —
// se le pide a un endpoint que construye Joel, mandándole la imagen + category_id, y ese
// endpoint devuelve ya las regiones simplificadas (left/top/width/height/confidence/tagName).
//
// Distinto de customVisionService.js: ese archivo sí habla directo con la API de
// ENTRENAMIENTO de Custom Vision (crear proyecto, subir imágenes, regiones, entrenar) para
// el pipeline de anotación/entrenamiento (Issues 8.1-8.3). Este archivo es solo para el
// paso de PREDICCIÓN sobre el modelo ya publicado, en el flujo de visita — un endpoint
// interno distinto, que Joel aún no ha entregado.
//
// ESTADO ACTUAL: STUB — DETECTION_ENDPOINT_URL todavía no está configurado (nadie lo ha
// entregado). En modo stub NO inventa detecciones: devuelve pending:true y regions:[] para
// que detectionPipelineService.js marque la foto como "detección pendiente" en vez de
// fallar el flujo completo de la visita — mismo criterio que ya usa la guía para el caso de
// "no hay ningún modelo PUBLISHED todavía" (sección 5.1).
//
// TODO: una vez que Joel confirme la URL/contrato real del endpoint, completar
// callDetectionEndpoint() — el formato esperado de respuesta (ya simplificado, según la
// guía sección 5.2) es:
//   { predictions: [{ probability, tagName, boundingBox: { left, top, width, height } }] }

function isConfigured() {
  return Boolean(process.env.DETECTION_ENDPOINT_URL);
}

// buffer: imagen completa de la visita (ya guardada en Blob, se re-envía el mismo buffer).
// categoryId: category_id de la foto — el endpoint de Joel decide con eso a qué modelo
// publicado mandarla (no lo decide este servicio).
// Devuelve: { pending: boolean, regions: [{ left, top, width, height, confidence, tagName }] }
async function detectRegions(buffer, categoryId) {
  if (!isConfigured()) {
    console.warn(
      '[visionDetectionService] DETECTION_ENDPOINT_URL no configurado — sin endpoint de ' +
      'Joel todavía (guía v1.9, sección 5.2). Detección marcada como pendiente.'
    );
    return { pending: true, regions: [] };
  }

  const res = await fetch(process.env.DETECTION_ENDPOINT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(process.env.DETECTION_ENDPOINT_KEY && { 'x-api-key': process.env.DETECTION_ENDPOINT_KEY }),
      'x-category-id': String(categoryId),
    },
    body: buffer,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Endpoint de detección (Joel) respondió ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const predictions = data?.predictions ?? [];

  return {
    pending: false,
    regions: predictions.map(p => ({
      left:       p.boundingBox?.left ?? p.left,
      top:        p.boundingBox?.top ?? p.top,
      width:      p.boundingBox?.width ?? p.width,
      height:     p.boundingBox?.height ?? p.height,
      confidence: p.probability ?? p.confidence,
      tagName:    p.tagName,
    })),
  };
}

module.exports = { isConfigured, detectRegions };
