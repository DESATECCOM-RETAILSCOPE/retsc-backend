// Servicio de integración con Azure Custom Vision.
//
// ESTADO ACTUAL: STUB — las credenciales aún no están disponibles.
// Todas las funciones devuelven null/false sin lanzar error.
// El llamador (aiInfrastructureService) interpreta null como "Custom Vision no disponible"
// y deja el modelo en estado PENDING.
//
// CUANDO LLEGUEN LAS CREDENCIALES:
//   1. Agregar a .env: CUSTOM_VISION_TRAINING_KEY, CUSTOM_VISION_ENDPOINT,
//      CUSTOM_VISION_PREDICTION_KEY, CUSTOM_VISION_PREDICTION_RESOURCE_ID
//   2. Instalar el SDK: npm install @azure/cognitiveservices-customvision-training
//                       npm install @azure/cognitiveservices-customvision-prediction
//      (agregar también @azure/ms-rest-js para el ApiKeyCredentials)
//   3. Completar las funciones marcadas con TODO abajo
//   4. Correr el backfill para categorías existentes: node scripts/backfill-smart-categories.js
//
// Documentación del SDK:
//   https://learn.microsoft.com/azure/cognitive-services/custom-vision-service/quickstarts/object-detection

// Verifica si las credenciales de Custom Vision están configuradas en el entorno.
function isConfigured() {
  return Boolean(
    process.env.CUSTOM_VISION_TRAINING_KEY &&
    process.env.CUSTOM_VISION_ENDPOINT
  );
}

// Crea un proyecto de Custom Vision para una categoría.
// Devuelve { id, name } del proyecto creado, o null si las credenciales no están disponibles.
//
// TODO: implementar cuando lleguen las credenciales.
//   Ejemplo de implementación:
//     const { TrainingAPIClient } = require('@azure/cognitiveservices-customvision-training');
//     const { ApiKeyCredentials } = require('@azure/ms-rest-js');
//     const client = new TrainingAPIClient(
//       new ApiKeyCredentials({ inHeader: { 'Training-key': process.env.CUSTOM_VISION_TRAINING_KEY } }),
//       process.env.CUSTOM_VISION_ENDPOINT
//     );
//     const project = await client.createProject(name, { classificationType: 'Multiclass' });
//     return { id: project.id, name: project.name };
async function createProject(name) {
  if (!isConfigured()) {
    // TEMPORAL: comportamiento stub mientras no hay credenciales.
    // Cambiar esto por la implementación real (ver TODO arriba).
    return null;
  }

  // TODO: implementar llamada real al SDK de Custom Vision.
  // Por ahora devuelve null incluso si isConfigured() es true,
  // hasta que se complete la implementación.
  console.warn('[customVision] isConfigured=true pero createProject aún no implementado.');
  return null;
}

// TODO: agregar getProjectStatus(projectId) cuando se implemente el ciclo completo de entrenamiento.
// TODO: agregar triggerTraining(projectId) para disparar el entrenamiento desde un endpoint admin.
// TODO: agregar getPublishedIterations(projectId) para obtener el modelo publicado.

// Registra una imagen de góndola en un proyecto de Custom Vision (object detection).
// buffer: Buffer de la imagen
// projectId: ID del proyecto Custom Vision
// tagId: ID del tag a asignar (uno por categoría de góndola)
// Devuelve { cvImageId } o { stub: true, cvImageId } si las credenciales no están disponibles.
//
// TODO: implementar con el SDK cuando lleguen las credenciales (ver createProject arriba).
async function createImageFromData(buffer, projectId, tagId) {
  if (!isConfigured()) {
    const crypto = require('crypto');
    return { stub: true, cvImageId: `stub-${crypto.randomUUID()}` };
  }
  console.warn('[customVision] isConfigured=true pero createImageFromData aún no implementado.');
  return null;
}

module.exports = { isConfigured, createProject, createImageFromData };
