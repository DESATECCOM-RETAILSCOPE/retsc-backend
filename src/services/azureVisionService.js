// Stub de Azure Computer Vision para descripción de fotos de góndola (Issue 7.2 etapa 4).
//
// ESTADO: STUB — retorna respuesta simulada hasta que se configuren las credenciales.
// Las credenciales requeridas son: AZURE_VISION_KEY y AZURE_VISION_ENDPOINT.
//
// CUANDO LLEGUEN LAS CREDENCIALES:
//   1. Agregar a .env: AZURE_VISION_KEY, AZURE_VISION_ENDPOINT
//   2. npm install @azure/ai-vision-image-analysis
//   3. Completar la función caption() con el SDK real
//
// La función isShelf() es también un stub: siempre devuelve true.
// Cuando haya un modelo o criterio concreto para detectar góndolas, implementarla.

function isConfigured() {
  return Boolean(process.env.AZURE_VISION_KEY && process.env.AZURE_VISION_ENDPOINT);
}

// Genera una descripción en lenguaje natural del contenido de la imagen.
// Devuelve { caption, confidence } o { stub: true, caption, confidence } en modo stub.
async function caption(buffer) {
  if (!isConfigured()) {
    return { stub: true, caption: 'shelf photo (stub)', confidence: 1.0 };
  }
  // TODO: implementar con @azure/ai-vision-image-analysis cuando lleguen credenciales.
  console.warn('[azureVision] isConfigured=true pero caption() no implementado.');
  return { stub: true, caption: 'shelf photo (stub)', confidence: 1.0 };
}

// Evalúa si la imagen corresponde a una foto de góndola de supermercado.
// Siempre devuelve true en modo stub.
async function isShelf(_buffer) {
  return true;
}

module.exports = { caption, isShelf };
