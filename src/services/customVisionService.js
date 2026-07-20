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
// Devuelve { stub, cvImageId, duplicate }.
//
// IMPLEMENTADO (Issue 8.2, 2026-07-19 — cierre del hueco que bloqueaba el E2E: sin esto,
// annotationSyncService.createImageRegions() recibía un cvImageId falso y Custom Vision
// respondía 400 "No image regions provided" para el 100% de las fotos).
//
// Formato verificado contra CV real (API v3.3, no hay SDK):
//   POST {endpoint}/customvision/v3.3/training/projects/{projectId}/images?tagIds={tagId}
//     Content-Type: application/octet-stream, body: el binario crudo de la imagen (NO
//     multipart/form-data — un intento con FormData + 'imageData' devolvió 415 Unsupported
//     Media Type; el endpoint correcto para subir UNA imagen desde bytes es este, no
//     /images/imagefiles ni /images/files, que son variantes para otros casos de uso).
//     tagIds es opcional y repetible (?tagIds=a&tagIds=b) — acá se manda una sola.
//   Respuesta: { isBatchSuccessful, images: [{ status, image: { id, ... } }] }
//     status observado: 'OK' (subida nueva) | 'OKDuplicate' (Custom Vision ya tenía esta
//     imagen — probablemente por hash interno — y devuelve el id existente; se trata como
//     éxito, no como error, reutilizando ese id).
//
// Si !isConfigured() o projectId es null (modelo aún en PENDING): devuelve stub con ID
// simulado, igual que antes — permite probar el resto del flujo sin credenciales.
//
// tagId resuelve el canal de la foto (OMT/DTT/CONVENIENCE → tag de Custom Vision) — ver
// resolveTagId() en annotationSyncService.js. NOTA (Issue #35, sin resolver acá): el mapeo
// hoy es una env var global (CV_TAG_OMT/DTT/CONVENIENCE) pero cada proyecto CV tiene sus
// propios tag IDs — con más de una categoría con proyecto activo simultáneo, esa única env
// var no puede ser correcta para todas a la vez. Confirmado en el E2E previo. Fuera de
// alcance de este cierre; requiere un mapeo canal+categoría→tagId persistido, no una sola
// env var por canal.
async function createImageFromData(projectId, buffer, tagId) {
  if (!isConfigured() || !projectId) {
    return { stub: true, cvImageId: `stub-${crypto.randomUUID()}` };
  }

  const params = tagId ? `?${new URLSearchParams({ tagIds: tagId })}` : '';
  const result = await cvFetch(`projects/${projectId}/images${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });

  const entry = result?.images?.[0];
  if (!entry) {
    throw new Error('Custom Vision no devolvió ninguna imagen en la respuesta de createImageFromData.');
  }
  if (entry.status !== 'OK' && entry.status !== 'OKDuplicate') {
    throw new Error(`Custom Vision rechazó la imagen (status=${entry.status}).`);
  }

  return { stub: false, cvImageId: entry.image.id, duplicate: entry.status === 'OKDuplicate' };
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

// Issue 8.3 — entrenamiento del modelo de detección.
//
// Formato verificado (Custom Vision Training API v3.3 — no se pudo abrir la página interactiva
// de Microsoft Learn desde este entorno, se confirmó por búsqueda):
//
//   POST {endpoint}/customvision/v3.3/training/projects/{projectId}/train?trainingType=Regular
//     Sin body. `trainingType` default es 'Regular' si se omite el query param — acá se manda
//     explícito de todas formas (decisión post-revisión de jefatura, BETA: no se reserva
//     presupuesto Advanced, Regular alcanza con el volumen actual de 15 fotos por categoría por
//     canal; Advanced se evalúa post-BETA). Se prefiere explícito antes que depender del default
//     no documentado oficialmente de la API, por si Azure lo cambia sin aviso. Devuelve el
//     objeto Iteration recién creado: { id, name, status, created, ... }.
//
//   GET {endpoint}/customvision/v3.3/training/projects/{projectId}/iterations/{iterationId}
//     Devuelve el mismo objeto Iteration actualizado. `status` observado: 'New' | 'Training' |
//     'Completed' | 'Failed'.
//
//   GET {endpoint}/.../iterations/{iterationId}/performance
//     Solo tiene sentido cuando la iteración está 'Completed'. Devuelve
//     { precision, recall, averagePrecision, precisionStdDeviation, recallStdDeviation,
//       perTagPerformance: [...] }. `averagePrecision` es el mAP.

// Inicia el entrenamiento de un proyecto. Devuelve la iteración creada ({ id, status, ... }).
// Lanza si la API falla (el llamador en modelTrainingService decide cómo reaccionar).
// trainingType default 'Regular' — ver nota de cabecera de esta sección. No manda
// reservedBudgetInHours (parámetro exclusivo de Advanced, no aplica a Regular).
async function trainProject(projectId, { trainingType = 'Regular' } = {}) {
  const params = new URLSearchParams({ trainingType });
  const iteration = await cvFetch(`projects/${projectId}/train?${params}`, { method: 'POST' });
  console.log(`[customVision] entrenamiento iniciado — proyecto=${projectId} iterationId=${iteration.id} status=${iteration.status} trainingType=${trainingType}`);
  return iteration;
}

// Consulta el estado actual de una iteración (para polling).
async function getIteration(projectId, iterationId) {
  return cvFetch(`projects/${projectId}/iterations/${iterationId}`);
}

// Consulta las métricas de rendimiento de una iteración ya completada.
async function getIterationPerformance(projectId, iterationId) {
  return cvFetch(`projects/${projectId}/iterations/${iterationId}/performance`);
}

module.exports = {
  isConfigured,
  createProject,
  createImageFromData,
  createImageRegions,
  deleteImageRegion,
  deleteImages,
  trainProject,
  getIteration,
  getIterationPerformance,
};
