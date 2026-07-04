// Servicio de integración con Azure AI Vision (Image Analysis 4.0).
//
// ESTADO ACTUAL: STUB — las credenciales de Image Analysis no están completamente
// configuradas para este flujo (se comparten con el pipeline cognitivo de SKUs).
// Todas las funciones en modo stub devuelven resultados permisivos para no bloquear
// el flujo de desarrollo ni el modo mock con BLOB_STORAGE_MODE=mock.
//
// CUANDO LLEGUEN LAS CREDENCIALES:
//   Las variables AZURE_VISION_ENDPOINT y AZURE_VISION_KEY ya existen en .env
//   (las usa el pipeline cognitivo de SKUs). Solo falta completar la implementación:
//   1. Instalar el SDK: npm install @azure-rest/ai-vision-image-analysis
//   2. Completar analyzeCaption() e isShelf() con los TODO abajo.
//
// Documentación SDK:
//   https://learn.microsoft.com/azure/ai-services/computer-vision/overview-image-analysis
//   https://learn.microsoft.com/azure/ai-services/computer-vision/concept-describe-images-40
//
// TODOs pendientes:
//   - Implementar analyzeCaption() con Image Analysis 4.0 (caption feature)
//   - Implementar isShelf() con Image Analysis 4.0 (tags/objects feature)

// Verifica si las credenciales de Azure AI Vision están configuradas en el entorno.
function isConfigured() {
  return Boolean(process.env.AZURE_VISION_ENDPOINT && process.env.AZURE_VISION_KEY);
}

// Analiza el caption de una imagen y devuelve la confianza del modelo.
// Usado para rechazar fotos de contenido ambiguo antes de subirlas al dataset.
//
// En modo stub (sin credenciales): permisivo — confidence=1, accepted=true para
// no bloquear el flujo de desarrollo ni pruebas en mock.
//
// TODO: implementar con Image Analysis 4.0 cuando las credenciales estén activas:
//   const ImageAnalysisClient = require('@azure-rest/ai-vision-image-analysis').default;
//   const { AzureKeyCredential } = require('@azure/core-auth');
//   const client = ImageAnalysisClient(
//     process.env.AZURE_VISION_ENDPOINT,
//     new AzureKeyCredential(process.env.AZURE_VISION_KEY)
//   );
//   const result = await client.path('/imageanalysis:analyze').post({
//     body: buffer,
//     queryParameters: { features: ['Caption'] },
//     contentType: 'application/octet-stream',
//   });
//   const caption = result.body.captionResult;
//   return { stub: false, caption: caption.text, confidence: caption.confidence,
//            accepted: caption.confidence >= threshold };
async function analyzeCaption(_buffer) {
  if (!isConfigured()) {
    return { stub: true, caption: null, confidence: 1, accepted: true };
  }
  // TODO: implementar llamada real a Azure Image Analysis 4.0 (caption).
  console.warn('[azureVision] isConfigured=true pero analyzeCaption aún no implementado. Pasando permisivo.');
  return { stub: true, caption: null, confidence: 1, accepted: true };
}

// Detecta si una imagen contiene una góndola de supermercado.
// Usado para rechazar fotos que no sean del contexto esperado (retail/shelf).
//
// En modo stub (sin credenciales): permisivo — isShelf=true, tags=[].
//
// TODO: implementar con Image Analysis 4.0 (tags feature) cuando las credenciales estén activas.
//   Tags a buscar con confidence > 0.5: 'shelf', 'supermarket', 'aisle', 'retail', 'gondola'.
//   Si ninguno aparece → { stub:false, isShelf:false, tags }.
async function isShelf(_buffer) {
  if (!isConfigured()) {
    return { stub: true, isShelf: true, tags: [] };
  }
  // TODO: implementar llamada real a Azure Image Analysis 4.0 (tags).
  console.warn('[azureVision] isConfigured=true pero isShelf aún no implementado. Pasando permisivo.');
  return { stub: true, isShelf: true, tags: [] };
}

module.exports = { isConfigured, analyzeCaption, isShelf };
