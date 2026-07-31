// Issue 8.2 — Sincronización de anotaciones aprobadas/rechazadas a Custom Vision +
// verificación de umbral de entrenamiento.
//
// INTERFAZ ACORDADA con el disparador de aprobación del cliente (#54, construido por otra
// persona; este servicio NO expone ruta HTTP propia):
//
//   syncApprovedPhoto(photoId, { clienteAjustoCajitas })
//     — Llamar INMEDIATAMENTE DESPUÉS de que se apruebe la foto (photo_status='APROBADA' en
//       RETSC_AI_TRAINING_PHOTOS — ver FIX 2026-07-26 más abajo).
//     — Si clienteAjustoCajitas === false, no se toca Custom Vision (las regiones ya estaban
//       sincronizadas de una corrección previa); solo se verifica el umbral de entrenamiento.
//     — Si clienteAjustoCajitas es true (o no viene), se resincronizan todas las cajitas
//       actuales de la foto contra Custom Vision antes de verificar el umbral.
//
//   removeRejectedPhoto(photoId)
//     — Llamar cuando el cliente rechaza la foto. Borra las regiones (y la imagen) en
//       Custom Vision pero CONSERVA el registro en SQL — el issue pide no borrar filas.
//
// Ninguna de las dos funciones lanza por fallos de Custom Vision: la aprobación/rechazo del
// cliente ya quedó persistido en SQL antes de llamar a estas funciones y no debe revertirse
// por un problema de sincronización. Los fallos se registran en RETSC_AI_TRAINING_PHOTOS
// (cv_sync_status='FAILED' / cv_sync_error / cv_sync_attempts) para reintento manual posterior.
//
// FIX 2026-07-26 — migración de esquema del equipo DBA (mismo cambio que en annotationRepo.js
// y trainingPhotoRepo.js): dtc_category_id, canal, photo_notes y cv_sync_status/error/attempts
// se movieron de RETSC_AI_TRAINING_ANNOTATIONS a la tabla nueva RETSC_AI_TRAINING_PHOTOS.
// Este archivo asumía que esas columnas venían en cada fila de `annotationRepo.listByPhoto()`
// (`rows[0].dtc_category_id`, `rows[0].canal`, `r.photo_notes`) — ya no es así. Ahora se busca
// la fila de foto por separado (trainingPhotoRepo.findById) y se pasa junto con las anotaciones
// a las funciones que la necesitan. cv_region_id (por cajita) sigue en la tabla de anotaciones;
// cv_sync_status/error/attempts (por foto, ya no por cajita) se actualizan en la tabla de fotos.
//
// Dependencias externas pendientes / TODOs:
//   - Probar contra un flujo real de #42 (anotación) + #54 (aprobación) cuando estén listos.
//   - IMPORTANTE: aiModelRepo.findByCategoryId() filtra solo por is_active=1 sin garantizar
//     unicidad — si alguna vez hay más de una fila activa para una categoría, esta función
//     (y checkAndUpdateThreshold) puede resolver el modelo equivocado. Considerar un índice
//     único filtrado (category_id) WHERE is_active=1 en RETSC_AI_DETECTION_MODELS.
//   - El cvImageId de una foto viaja embebido en el texto libre `photo_notes` (formato
//     "blob:... | sha256:... | cvImageId:...", escrito por shelfPhotoUploadService), ahora en
//     RETSC_AI_TRAINING_PHOTOS.photo_notes. No tiene columna propia — si esa convención
//     cambia, actualizar extractCvImageId().
//   - CONFIRMADO contra un proyecto CV real (2026-07-12): Custom Vision NO preserva el orden de
//     envío en created[] (se probó con 4 regiones de left distinto — volvieron reordenadas). Por
//     eso la correlación se hace por coordenadas (coordsMatch), no por índice de lote.

const annotationRepo    = require('../repositories/annotationRepo');
const trainingPhotoRepo = require('../repositories/trainingPhotoRepo');
const aiModelRepo       = require('../repositories/aiModelRepo');
const customVisionService = require('./customVisionService');

const CANALES = ['OMT', 'DTT', 'CONVENIENCE'];

const THRESHOLD = () => parseInt(process.env.SHELF_TRAINING_THRESHOLD || '15', 10);

// Estados de RETSC_AI_DETECTION_MODELS en los que el modelo ya avanzó más allá de
// "esperando imágenes" — no corresponde volver a marcarlo IMAGES_UPLOADED.
const SKIP_THRESHOLD_STATUSES = new Set(['TRAINING', 'READY', 'AWAITING_APPROVAL', 'IMAGES_UPLOADED']);

function resolveTagId(canal) {
  const map = {
    OMT:         process.env.CV_TAG_OMT,
    DTT:         process.env.CV_TAG_DTT,
    CONVENIENCE: process.env.CV_TAG_CONVENIENCE,
  };
  return map[canal] || null;
}

// Custom Vision no devuelve un ID de correlación propio en createImageRegions — se correlaciona
// por coordenadas (bbox_* vs left/top/width/height de la región devuelta).
//
// CONFIRMADO contra CV real (2026-07-12, coords de hasta 6 decimales): el round-trip por
// JSON/HTTP no introduce error de redondeo — la diferencia medida fue 0 en todos los casos.
// 1e-6 sobra como tolerancia; se deja de todas formas por si el motor de CV cambia de precisión.
//
// CASO BORDE — coords idénticas en 2 anotaciones de la misma foto: Custom Vision RECHAZA todo
// el batch con 400 "Duplicate image regions" (confirmado empíricamente) si dos regiones del
// mismo lote tienen el mismo left/top/width/height + tag en la misma imagen. Como el batch entero
// falla, syncRegionsForPhoto cae al catch y marca la foto entera como cv_sync_status='FAILED'
// (no solo las cajitas duplicadas) — comportamiento correcto según la regla de "nunca
// bloquear", pero significa que dos cajitas exactamente iguales en una foto bloquean la
// sincronización de esa foto entera hasta que se corrijan (una de las dos debe moverse aunque
// sea mínimamente). Vale la pena que el equipo de anotación lo sepa: bboxes idénticas ya son en
// sí una situación de datos rara (dos anotaciones ocupando exactamente el mismo espacio), pero
// hoy el error que verían es el genérico de CV, no algo explícito de "cajitas duplicadas".
const COORD_EPS = 1e-6;
function coordsMatch(a, b) {
  return Math.abs(a.bbox_left   - b.left)   < COORD_EPS &&
         Math.abs(a.bbox_top    - b.top)    < COORD_EPS &&
         Math.abs(a.bbox_width  - b.width)  < COORD_EPS &&
         Math.abs(a.bbox_height - b.height) < COORD_EPS;
}

// TEMPORAL — ver nota de cabecera: cvImageId no tiene columna propia, viaja en photo_notes.
// Recibe directamente el string de photo_notes de RETSC_AI_TRAINING_PHOTOS (antes buscaba
// entre varias filas de anotación porque el campo estaba duplicado ahí; ahora es un solo
// valor por foto).
function extractCvImageId(photoNotes) {
  if (!photoNotes) return null;
  const match = /cvImageId:(\S+)/.exec(photoNotes);
  return match ? match[1] : null;
}

// Marca sincronizadas las cajitas dadas (cv_region_id por cajita) y el estado de sync a
// nivel de foto (SYNCED). Dos tablas distintas — ver nota de cabecera.
async function markSynced(photoId, cvRegionIdsByAnnotation) {
  for (const [annotationId, regionId] of cvRegionIdsByAnnotation.entries()) {
    await annotationRepo.updateCvRegionId(annotationId, regionId);
  }
  await trainingPhotoRepo.updateCvSync(photoId, { syncStatus: 'SYNCED', syncError: null });
}

async function markFailed(photoId, error) {
  const message = error?.message || String(error);
  await trainingPhotoRepo.updateCvSync(photoId, { syncStatus: 'FAILED', syncError: message })
    .catch(e2 => console.error(`[annotationSync] no se pudo registrar cv_sync_status=FAILED para photo_id=${photoId}:`, e2.message));
}

// Borra en Custom Vision las regiones viejas (cv_region_id) de las cajitas dadas.
// No lanza por región individual que falle en borrarse — sigue con las demás.
async function deleteOldRegions(projectId, rows) {
  const oldRegionIds = rows.map(r => r.cv_region_id).filter(Boolean);
  for (const regionId of oldRegionIds) {
    await customVisionService.deleteImageRegion(projectId, regionId);
  }
}

// Guarda anti-duplicados (ajuste post-revisión jefatura, Issue 8.2): una anotación con
// cv_region_id ya seteado se considera sincronizada de forma definitiva y NUNCA se reenvía a
// Custom Vision, aunque syncRegionsForPhoto se vuelva a llamar para la misma foto — cubre:
//   1. Usuario guarda, sale y vuelve → cajitas recargadas desde BD → las ya sincronizadas
//      no se reenvían (cv_region_id ya está seteado).
//   2. Retry automático tras un fallo de sync → no reintenta las que ya quedaron SYNCED.
//   3. Doble submit (doble clic antes de que responda el servidor) → si el primer submit ya
//      alcanzó a persistir cv_region_id antes del segundo, el segundo las salta.
// NOTA — ventana de carrera real en el caso 3: si dos requests concurrentes llegan a este punto
// ANTES de que markSynced() del primero escriba cv_region_id, ambos ven cv_region_id=NULL para
// las mismas anotaciones y ambos intentarían crear la región (duplicado real en Custom Vision,
// no solo trabajo redundante). El filtro de abajo no cierra esa ventana — TODO: si el doble
// submit resulta ser un caso real (no solo teórico) desde el canvas, evaluar un mecanismo de
// idempotencia (p. ej. UPDATE optimista "reservar" con cv_sync_status antes de llamar a CV, o
// una constraint) — no se toca estructura de tablas en este ajuste sin acordarlo antes.
function splitByCvRegionId(rows) {
  const pendingSync   = rows.filter(r => !r.cv_region_id);
  const alreadySynced = rows.filter(r => r.cv_region_id);
  return { pendingSync, alreadySynced };
}

// Sincroniza las cajitas actuales de una foto contra Custom Vision:
// borra las regiones viejas y crea las nuevas a partir de las coordenadas actuales en SQL.
// Solo procesa anotaciones sin cv_region_id (ver splitByCvRegionId) — las ya sincronizadas
// quedan intactas, no se tocan ni se borran ni se recrean.
// Nunca lanza — cualquier fallo se registra vía markFailed y se loguea.
// `photo` = fila de RETSC_AI_TRAINING_PHOTOS (category_id, canal, photo_notes);
// `rows` = anotaciones (cajitas) de esa foto.
async function syncRegionsForPhoto(photo, rows) {
  const categoryId = photo.category_id;

  const { pendingSync, alreadySynced } = splitByCvRegionId(rows);

  if (alreadySynced.length) {
    console.log(`[annotationSync] photo_id=${photo.photo_id}: ${alreadySynced.length} anotación(es) ya tenían cv_region_id — se omiten (no se reenvían a Custom Vision)`);
  }

  if (!pendingSync.length) {
    console.log(`[annotationSync] photo_id=${photo.photo_id}: todas las anotaciones ya estaban sincronizadas — nada que enviar a Custom Vision`);
    return;
  }

  const model     = await aiModelRepo.findByCategoryId(categoryId);
  const projectId = model?.customvision_project_id ?? null;

  if (!customVisionService.isConfigured() || !projectId) {
    console.warn(`[annotationSync] Custom Vision no configurado o sin proyecto para categoría ${categoryId} — se omite sync de regiones (photo_id=${photo.photo_id})`);
    return;
  }

  try {
    // pendingSync ya filtró todo lo que tenía cv_region_id, así que esto es un no-op hoy —
    // se deja por si en el futuro un cv_region_id "huérfano" (sin fila SYNCED) llegara a colarse.
    await deleteOldRegions(projectId, pendingSync);

    const cvImageId = extractCvImageId(photo.photo_notes);
    if (!cvImageId) {
      throw new Error(`No se encontró cvImageId en photo_notes para photo_id=${photo.photo_id}`);
    }
    const tagId = resolveTagId(photo.canal);

    const regionsToCreate = pendingSync.filter(r =>
      r.bbox_left != null && r.bbox_top != null && r.bbox_width != null && r.bbox_height != null
    );

    const created = await customVisionService.createImageRegions(
      projectId,
      regionsToCreate.map(r => ({
        imageId: cvImageId,
        tagId,
        left:    r.bbox_left,
        top:     r.bbox_top,
        width:   r.bbox_width,
        height:  r.bbox_height,
      }))
    );

    // CONFIRMADO (prueba real contra un proyecto CV descartable): Custom Vision NO preserva
    // el orden de envío en created[] — se correlaciona cada región devuelta con la anotación
    // que la originó comparando left/top/width/height (la API no da un ID de correlación propio).
    // Cada región devuelta se consume de a una para evitar reusar la misma anotación dos veces
    // si dos cajitas tuvieran coordenadas idénticas.
    const pending = regionsToCreate.map(r => ({ ...r }));
    const cvRegionIdsByAnnotation = new Map();
    for (const cvRegion of created) {
      const idx = pending.findIndex(r => coordsMatch(r, cvRegion));
      if (idx === -1) {
        console.warn(`[annotationSync] no se encontró match de coordenadas para region_id=${cvRegion.regionId} devuelta por CV (photo_id=${photo.photo_id})`);
        continue;
      }
      cvRegionIdsByAnnotation.set(pending[idx].annotation_id, cvRegion.regionId);
      pending.splice(idx, 1);
    }
    if (pending.length) {
      console.warn(`[annotationSync] ${pending.length} anotación(es) de photo_id=${photo.photo_id} quedaron sin region_id tras el match por coordenadas`);
    }

    await markSynced(photo.photo_id, cvRegionIdsByAnnotation);
    console.log(`[annotationSync] photo_id=${photo.photo_id}: ${created.length} regiones sincronizadas a Custom Vision (proyecto=${projectId})`);
  } catch (err) {
    console.error(`[annotationSync] fallo al sincronizar photo_id=${photo.photo_id} con Custom Vision:`, err.message);
    await markFailed(photo.photo_id, err);
  }
}

// Borra en Custom Vision las regiones (y opcionalmente la imagen) de una foto rechazada.
// Nunca lanza — cualquier fallo se registra vía markFailed y se loguea.
async function removeRegionsForPhoto(photo, rows) {
  const categoryId = photo.category_id;

  const model     = await aiModelRepo.findByCategoryId(categoryId);
  const projectId = model?.customvision_project_id ?? null;

  if (!customVisionService.isConfigured() || !projectId) {
    console.warn(`[annotationSync] Custom Vision no configurado o sin proyecto para categoría ${categoryId} — se omite limpieza de CV (photo_id=${photo.photo_id})`);
    return;
  }

  try {
    await deleteOldRegions(projectId, rows);

    const cvImageId = extractCvImageId(photo.photo_notes);
    if (cvImageId) {
      await customVisionService.deleteImages(projectId, [cvImageId]);
    }

    // cv_region_id queda en null tras el borrado; no hubo regiones nuevas que crear.
    await markSynced(photo.photo_id, new Map());
    console.log(`[annotationSync] photo_id=${photo.photo_id}: regiones/imagen eliminadas de Custom Vision (SQL conservado)`);
  } catch (err) {
    console.error(`[annotationSync] fallo al limpiar photo_id=${photo.photo_id} en Custom Vision:`, err.message);
    await markFailed(photo.photo_id, err);
  }
}

// Verifica, canal por canal, si una categoría alcanzó el umbral de fotos aprobadas para
// habilitar entrenamiento. Si lo alcanzó y el modelo aún no avanzó más allá de eso,
// marca RETSC_AI_DETECTION_MODELS.status = 'IMAGES_UPLOADED'.
// Mismo umbral/lógica que la Etapa 8 de shelfPhotoUploadService, generalizado a todos los
// canales de la categoría (no solo el canal de la foto recién subida/aprobada).
async function checkAndUpdateThreshold(categoryId) {
  const model = await aiModelRepo.findByCategoryId(categoryId);
  if (!model) {
    console.warn(`[annotationSync] no hay modelo activo para categoría ${categoryId} — se omite verificación de umbral`);
    return;
  }

  if (SKIP_THRESHOLD_STATUSES.has(model.status)) {
    console.log(`[annotationSync] modelo de categoría ${categoryId} ya está en estado ${model.status} — no se reevalúa umbral`);
    return;
  }

  const threshold = THRESHOLD();
  for (const canal of CANALES) {
    const count = await trainingPhotoRepo.countValidatedApprovedByCategoryChannel(categoryId, canal);
    if (count >= threshold) {
      await aiModelRepo.updateStatus(model.detection_model_id, 'IMAGES_UPLOADED');
      console.log(`[annotationSync] umbral alcanzado — categoria=${categoryId} canal=${canal} (${count}/${threshold}) → modelo marcado IMAGES_UPLOADED`);
      return;
    }
  }
}

// Punto de entrada tras aprobar la foto (photo_status='APROBADA' ya persistido en
// RETSC_AI_TRAINING_PHOTOS por trainingPhotoRepo.approvePhoto).
async function syncApprovedPhoto(photoId, { clienteAjustoCajitas } = {}) {
  const photo = await trainingPhotoRepo.findById(photoId);
  if (!photo) {
    console.warn(`[annotationSync] photo_id=${photoId} no encontrada — nada que sincronizar`);
    return { synced: false, reason: 'PHOTO_NOT_FOUND' };
  }

  const rows = await annotationRepo.listByPhoto(photoId);
  if (!rows.length) {
    console.warn(`[annotationSync] photo_id=${photoId} sin anotaciones — nada que sincronizar`);
    return { synced: false, reason: 'NO_ANNOTATIONS' };
  }

  if (clienteAjustoCajitas === false) {
    console.log(`[annotationSync] photo_id=${photoId}: cliente no ajustó cajitas, ya estaba sincronizado — se omite llamada a Custom Vision`);
  } else {
    await syncRegionsForPhoto(photo, rows);
  }

  await checkAndUpdateThreshold(photo.category_id);
  return { synced: clienteAjustoCajitas !== false };
}

// Punto de entrada tras rechazar la foto. Conserva el registro en SQL.
async function removeRejectedPhoto(photoId) {
  const photo = await trainingPhotoRepo.findById(photoId);
  if (!photo) {
    console.warn(`[annotationSync] photo_id=${photoId} no encontrada — nada que borrar de Custom Vision`);
    return { removed: false, reason: 'PHOTO_NOT_FOUND' };
  }

  const rows = await annotationRepo.listByPhoto(photoId);
  if (!rows.length) {
    console.warn(`[annotationSync] photo_id=${photoId} sin anotaciones — nada que borrar de Custom Vision`);
    return { removed: false, reason: 'NO_ANNOTATIONS' };
  }

  await removeRegionsForPhoto(photo, rows);
  return { removed: true };
}

module.exports = {
  syncApprovedPhoto,
  removeRejectedPhoto,
  // exportada para tests / reintento manual — no es parte de la interfaz acordada con #54
  checkAndUpdateThreshold,
};
