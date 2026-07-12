// Servicio de integración con Azure Custom Vision.
//
// Issue 8.1: createProject() real implementado — Object Detection, dominio "General".
// Usa fetch nativo en lugar del SDK (@azure/cognitiveservices-customvision-training) porque
// la key de Azure AI Services unificada contiene caracteres no-ASCII que el módulo http de
// Node.js rechaza en headers, mientras que fetch los acepta sin problema.
//
// Estado del modelo tras createProject exitoso: PROJECT_CREATED (no READY — sin imágenes aún).
//
// TODO (8.2/8.3): triggerTraining(projectId), getPublishedIterations(projectId)
// TODO (8.4): publishIteration(projectId, iterationId)

const crypto = require('crypto');

const CV_API = 'customvision/v3.3/training';

function isConfigured() {
  return Boolean(
    process.env.CUSTOM_VISION_TRAINING_KEY &&
    process.env.CUSTOM_VISION_ENDPOINT
  );
}

function cvFetch(path, options = {}) {
  const base = (process.env.CUSTOM_VISION_ENDPOINT || '').replace(/\/$/, '');
  const url  = `${base}/${CV_API}/${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Training-key': process.env.CUSTOM_VISION_TRAINING_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  }).then(async res => {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Custom Vision ${res.status}: ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  });
}

// Crea un proyecto de Object Detection en Custom Vision para una categoría.
// Busca el dominio "General (compact)" de ObjectDetection; cae en cualquier OD disponible.
// Devuelve { id, name } del proyecto creado, o null si las credenciales no están disponibles.
// Lanza si la API falla (el llamador en aiInfrastructureService captura y registra el error).
async function createProject(name) {
  if (!isConfigured()) return null;

  const domains = await cvFetch('domains');

  const domain =
    domains.find(d => d.type === 'ObjectDetection' && d.name === 'General (compact)') ||
    domains.find(d => d.type === 'ObjectDetection' && d.name === 'General') ||
    domains.find(d => d.type === 'ObjectDetection');

  if (!domain) {
    throw new Error('No se encontró ningún dominio de Object Detection en este recurso de Custom Vision.');
  }

  const params = new URLSearchParams({ name, domainId: domain.id });
  const project = await cvFetch(`projects?${params}`, { method: 'POST' });

  console.log(`[customVision] proyecto creado — id=${project.id} name=${project.name} domain=${domain.name}`);
  return { id: project.id, name: project.name };
}

// TODO (8.2): triggerTraining(projectId) — disparar entrenamiento desde endpoint admin.
// TODO (8.3): getPublishedIterations(projectId) — obtener el modelo publicado.

// Sube una imagen a Custom Vision SIN regiones para que el equipo DTC anote después (Issue 7.2 / #42).
// Devuelve { stub, cvImageId }.
//
// Si !isConfigured() o projectId es null (modelo aún en PENDING): devuelve stub con ID simulado.
// Esto permite probar el flujo end-to-end en mock sin bloquear por credenciales.
//
// tagId resuelve el canal de la foto (OMT/DTT/CONVENIENCE → tag de Custom Vision).
// El mapeo de canal a tagId vendrá del Issue #35. Por ahora se pasa null en stub
// o desde env opcionales CV_TAG_OMT / CV_TAG_DTT / CV_TAG_CONVENIENCE.
//
// TODO: implementar cuando se complete Issue 8.2:
//   const params = tagId ? `?tagIds=${tagId}` : '';
//   const formData = new FormData();
//   formData.append('imageData', new Blob([buffer]));
//   await cvFetch(`projects/${projectId}/images/imagefiles${params}`, { method: 'POST', body: formData, headers: {} });

async function createImageFromData(projectId, _buffer, _tagId) {
  if (!isConfigured() || !projectId) {
    return { stub: true, cvImageId: `stub-${crypto.randomUUID()}` };
  }
  // TODO: implementar llamada real (ver bloque arriba).
  console.warn('[customVision] createImageFromData aún no implementado. Devolviendo stub.');
  return { stub: true, cvImageId: `stub-${crypto.randomUUID()}` };
}

// Issue 8.2 — sincronización de anotaciones (regiones) a Custom Vision.
//
// Formato verificado (Custom Vision Training API v3.3 — no se pudo abrir la página
// interactiva de Microsoft Learn desde este entorno, se confirmó por búsqueda + consistencia
// con el resto de esta API, que usa el mismo patrón de query params repetidos, p. ej. imageIds):
//
//   POST {endpoint}/customvision/v3.3/training/projects/{projectId}/images/regions
//     body: { regions: [{ imageId, tagId, left, top, width, height }, ...] }   (máx. 64 por llamada)
//     left/top/width/height van normalizados 0..1 — mismo formato que SQL, sin conversión.
//     response: { created: [{ regionId, imageId, tagId, tagName, left, top, width, height, created }],
//                 duplicated: [...], exceeded: [...] }
//
//   DELETE {endpoint}/customvision/v3.3/training/projects/{projectId}/images/regions?regionIds={id}
//     regionIds es un parámetro repetible (regionIds=a&regionIds=b) para borrar varias a la vez;
//     acá se usa de a una porque así lo pide la interfaz acordada con annotationSyncService.
//     Devuelve 204 sin body.

// Crea regiones (bounding boxes) para imágenes que ya existen en el proyecto.
// regions: [{ imageId, tagId, left, top, width, height }] — coordenadas normalizadas 0..1.
// Trocea automáticamente en lotes de 64 (límite de la API).
// Devuelve el array combinado de regiones creadas (con su regionId).
// CONFIRMADO contra un proyecto CV real: el orden de `created[]` NO coincide con el orden de
// envío — el llamador debe correlacionar por coordenadas (left/top/width/height), no por índice.
// Ver annotationSyncService.coordsMatch() para el patrón ya usado en este repo.
async function createImageRegions(projectId, regions) {
  if (!regions || regions.length === 0) return [];

  const BATCH_SIZE = 64;
  const created = [];

  for (let i = 0; i < regions.length; i += BATCH_SIZE) {
    const batch = regions.slice(i, i + BATCH_SIZE);
    const body = {
      regions: batch.map(r => ({
        imageId: r.imageId,
        tagId:   r.tagId,
        left:    r.left,
        top:     r.top,
        width:   r.width,
        height:  r.height,
      })),
    };

    const result = await cvFetch(`projects/${projectId}/images/regions`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    created.push(...(result?.created ?? []));
  }

  return created;
}

// Elimina una región de una imagen en Custom Vision. No lanza si regionId es vacío (nada que borrar).
async function deleteImageRegion(projectId, regionId) {
  if (!regionId) return;
  await cvFetch(`projects/${projectId}/images/regions?regionIds=${encodeURIComponent(regionId)}`, {
    method: 'DELETE',
  });
}

// Elimina imágenes completas de un proyecto (uso opcional al rechazar una foto: además de
// borrar sus regiones, saca la imagen entera del set de entrenamiento).
async function deleteImages(projectId, imageIds) {
  if (!imageIds || imageIds.length === 0) return;
  const params = imageIds.map(id => `imageIds=${encodeURIComponent(id)}`).join('&');
  await cvFetch(`projects/${projectId}/images?${params}`, { method: 'DELETE' });
}

module.exports = {
  isConfigured,
  createProject,
  createImageFromData,
  createImageRegions,
  deleteImageRegion,
  deleteImages,
};
