// Issue 8.2 — Sincronización de anotaciones aprobadas/rechazadas a Custom Vision +
// verificación de umbral de entrenamiento.
//
// INTERFAZ ACORDADA con el disparador de aprobación del cliente (#54, construido por otra
// persona; este servicio NO expone ruta HTTP propia):
//
//   syncApprovedPhoto(photoId, { clienteAjustoCajitas })
//     — Llamar INMEDIATAMENTE DESPUÉS de que se apruebe la foto (photo_status='APROBADA' en
//       RETSC_AI_TRAINING_PHOTOS — ver FIX 2026-07-26 más abajo).
//     — Si clienteAjustoCajitas === false Y al menos una cajita de la foto ya tiene
//       cv_region_id (ya se sincronizó antes): no se toca Custom Vision, solo se verifica el
//       umbral. clienteAjustoCajitas=false solo tiene sentido como "no re-subas lo que ya
//       está" — asume que había algo que preservar.
//     — Si clienteAjustoCajitas === false pero NINGUNA cajita tiene cv_region_id (primera
//       aprobación, foto nunca sincronizada): el flag se IGNORA y se sincroniza igual — de lo
//       contrario la foto queda cv_sync_status='PENDING' para siempre, sin error ni log
//       (bug encontrado 2026-08-05: photo_id=1 quedó así, 73 cajitas nunca sincronizadas,
//       ver docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md).
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
// (cv_sync_status='ERROR' / cv_sync_error / cv_sync_attempts) para reintento manual posterior.
// (Renombrado de 'FAILED' a 'ERROR' 2026-08-03 para alinear con el valor que usa la spec v1.4
// — verificado que ningún filtro/consulta en el código dependía del literal 'FAILED'.)
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

const annotationRepo      = require('../repositories/annotationRepo');
const trainingPhotoRepo   = require('../repositories/trainingPhotoRepo');
const aiModelRepo         = require('../repositories/aiModelRepo');
const customVisionService = require('./customVisionService');
const modelTrainingService = require('./modelTrainingService');
const blobStorageService  = require('./blobStorageService');
const { hashBuffer }       = require('../utils/imageHasher');

const CANALES = ['OMT', 'DTT', 'CONVENIENCE'];

const THRESHOLD = () => parseInt(process.env.SHELF_TRAINING_THRESHOLD || '15', 10);

// Mismo container que usa shelfPhotoUploadService.js — necesario acá para el auto-registro
// defensivo (Opción C, ver autoRegisterImage()).
const SHELF_CONTAINER = () =>
  process.env.AZURE_GLOBAL_SHELF_CONTAINER || 'global-shelf-training';

// Estados de RETSC_AI_DETECTION_MODELS en los que un training ya está en curso — no
// corresponde re-evaluar el umbral mientras tanto (evita llamadas repetidas a
// modelTrainingService.startTraining() por cada foto que se sincroniza durante la ventana de
// ~20 min que dura un entrenamiento; esas llamadas fallarían igual con 409 dentro de
// startTraining(), pero silenciarlas acá evita ruido de logs).
//
// Deliberadamente NO incluye 'IMAGES_UPLOADED': `shelfPhotoUploadService.js` (Etapa 8, fuera
// de alcance de este cableado) también puede marcar ese estado por su cuenta, en el momento
// de SUBIR una foto — sin disparar training. Si 'IMAGES_UPLOADED' bloqueara la reevaluación
// acá, un modelo marcado por esa vía quedaría atascado ahí para siempre (nada más lo saca de
// ese estado). Al no bloquearlo, el próximo sync exitoso vuelve a evaluar el umbral con
// normalidad y sí dispara training si corresponde — el flujo se autocorrige.
//
// Deliberadamente NO incluye 'PUBLISHED' (ni el viejo 'READY'): un modelo ya publicado debe
// poder re-entrenarse cuando se acumulen +15 fotos SYNCED más — el propio conteo "desde el
// último trained_at" (ver checkAndUpdateThreshold) ya evita re-disparar con las mismas fotos,
// así que el estado no necesita bloquear ese caso.
//
// AWAITING_APPROVAL retirado 2026-08-03 (decisión de jefatura — ya no existe ese estado, ver
// aiModelRepo.js y docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md).
const SKIP_THRESHOLD_STATUSES = new Set(['TRAINING']);

// Issue #35 (resuelto 2026-08-03, cableado spec v1.4) — antes esto leía CV_TAG_OMT/DTT/
// CONVENIENCE (env vars globales, un solo tag id para TODAS las categorías del canal —
// incorrecto en cuanto hay más de un proyecto CV activo). Ahora resuelve el tag DENTRO del
// proyecto de la categoría vía customVisionService.ensureTag() (lista tags del proyecto, crea
// si no existe, reusa si ya está — no duplica). Convención de nombre: el canal solo
// ('OMT'/'DTT'/'CONVENIENCE'), sin componer con la categoría — el proyecto CV ya ES la
// categoría, así que el canal alcanza como nombre de tag dentro de él.
async function resolveTagId(projectId, canal) {
  const tag = await customVisionService.ensureTag(projectId, canal);
  return tag.id;
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
// falla, syncRegionsForPhoto cae al catch y marca la foto entera como cv_sync_status='ERROR'
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

// Opción C (auto-registro defensivo, 2026-08-05) — mitigación mientras el equipo de anotación
// (#42, Arthur) siga insertando fotos directo a Blob/SQL sin pasar por
// shelfPhotoUploadService.uploadShelfPhoto (desconexión estructural confirmada — ver
// "Desconexión con #42" en CLAUDE.md/docs). Cuando una foto llega al sync sin cvImageId en
// photo_notes, en vez de fallar acá mismo se la registra en Custom Vision: descarga el blob,
// la sube, y persiste photo_notes con el MISMO formato que arma uploadShelfPhoto (Etapa 7) —
// no se inventa un formato distinto — para que un sync futuro de la misma foto no tenga que
// volver a auto-registrar (idempotente por diseño: solo se llama cuando extractCvImageId()
// no encontró nada).
//
// Solo es posible si la foto tiene blob_path Y el blob existe de verdad en
// AZURE_GLOBAL_SHELF_CONTAINER — si no, se deja que la excepción se propague al catch de
// syncRegionsForPhoto (mismo mecanismo de siempre: marca cv_sync_status='ERROR' con mensaje
// claro, no rompe el resto de la corrida).
//
// NO se llama si Custom Vision no está configurado / sin proyecto — ese caso ya corta antes,
// en el guard de isConfigured()/projectId de syncRegionsForPhoto, así que acá siempre hay un
// projectId válido y CV configurado.
//
// ⚠ Este auto-registro es una MITIGACIÓN, no la corrección de fondo — mientras #42 no suba
// fotos vía POST /api/shelf-photos/upload, cada una de sus fotos pasará por acá con el
// warning de abajo. La corrección real (Opción A) es que #42 use ese endpoint.
async function autoRegisterImage(photo, projectId, tagId) {
  if (!photo.blob_path) {
    throw new Error(
      `photo_id=${photo.photo_id} no tiene cvImageId en photo_notes NI blob_path — ` +
      `no se puede auto-registrar en Custom Vision.`
    );
  }

  const buffer = await blobStorageService.downloadFromContainer({
    containerName: SHELF_CONTAINER(),
    blobPath: photo.blob_path,
  });

  const hash = await hashBuffer(buffer);
  const { cvImageId } = await customVisionService.createImageFromData(projectId, buffer, tagId);

  // Se guarda en las COLUMNAS propias (Issue #3), no concatenado en photo_notes:
  // esa columna quedó reservada para el motivo/comentario de la revisión.
  await trainingPhotoRepo.updateCvImageId(photo.photo_id, cvImageId, hash);

  console.warn(
    `[annotationSync] photo_id=${photo.photo_id} entró SIN cvImageId (no pasó por ` +
    `uploadShelfPhoto — ver desconexión #42), auto-registrada en Custom Vision con ` +
    `cvImageId=${cvImageId} — corrección de fondo pendiente (Opción A, ver CLAUDE.md).`
  );

  return cvImageId;
}

// Persiste cv_region_id por cajita, SIN tocar el estado de sync de la foto — extraído de
// markSynced() (Fix 2026-08-09, F1.1/Fase 2) para poder usarlo también en un sync PARCIAL
// (algunas cajitas confirmadas, otras no): esas cajitas confirmadas nunca deben perderse ni
// reenviarse de nuevo, aunque la foto en su conjunto no pueda marcarse SYNCED todavía.
// updateCvRegionId es un UPDATE idempotente — llamarlo dos veces con el mismo valor es inocuo.
async function persistRegionIds(cvRegionIdsByAnnotation) {
  for (const [annotationId, regionId] of cvRegionIdsByAnnotation.entries()) {
    await annotationRepo.updateCvRegionId(annotationId, regionId);
  }
}

// Marca sincronizadas las cajitas dadas (cv_region_id por cajita) y el estado de sync a
// nivel de foto (SYNCED). Dos tablas distintas — ver nota de cabecera.
async function markSynced(photoId, cvRegionIdsByAnnotation) {
  await persistRegionIds(cvRegionIdsByAnnotation);
  await trainingPhotoRepo.updateCvSync(photoId, { syncStatus: 'SYNCED', syncError: null });
}

// Correlaciona la lista de regiones devuelta por Custom Vision (createImageRegions) contra
// las anotaciones que se enviaron a crear, por coordenadas (ver coordsMatch — CV no preserva
// el orden ni da un ID de correlación propio). Se usa tanto lote por lote (onBatchCreated,
// éxito parcial o total) como sobre err.partialCreated (fallo a mitad de un lote).
function correlateCreatedRegions(regionsToCreate, createdList) {
  const pending = regionsToCreate.map(r => ({ ...r }));
  const cvRegionIdsByAnnotation = new Map();
  for (const cvRegion of createdList) {
    const idx = pending.findIndex(r => coordsMatch(r, cvRegion));
    if (idx === -1) continue;
    cvRegionIdsByAnnotation.set(pending[idx].annotation_id, cvRegion.regionId);
    pending.splice(idx, 1);
  }
  return { cvRegionIdsByAnnotation, unmatched: pending };
}

async function markFailed(photoId, error) {
  const message = error?.message || String(error);
  await trainingPhotoRepo.updateCvSync(photoId, { syncStatus: 'ERROR', syncError: message })
    .catch(e2 => console.error(`[annotationSync] no se pudo registrar cv_sync_status=ERROR para photo_id=${photoId}:`, e2.message));
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
    // FIX 2026-08-08: antes esta rama salía sin llamar a markSynced(), así que si
    // cv_sync_status de la FOTO quedaba en algo distinto de 'SYNCED' (ej. un reset manual,
    // o cualquier otra causa) mientras sus cajitas YA tenían cv_region_id, no había forma de
    // autocorregirlo — cada re-sync futuro volvía a caer acá y volvía a salir sin arreglar
    // nada. checkAndUpdateThreshold cuenta por cv_sync_status='SYNCED' a nivel de foto, así
    // que esto bloqueaba el disparo automático de entrenamiento con datos que en Custom
    // Vision ya estaban completos. Encontrado con category_id=2/OMT: 15 fotos con el 100% de
    // sus cajitas ya sincronizadas (710 anotaciones, todas con cv_region_id) pero
    // cv_sync_status='PENDING' en la foto. markSynced(photoId, new Map()) no reenvía nada
    // (mapa vacío → el loop de arriba no itera nada), solo asienta cv_sync_status='SYNCED'.
    console.log(`[annotationSync] photo_id=${photo.photo_id}: todas las anotaciones ya estaban sincronizadas — nada que enviar a Custom Vision`);
    await markSynced(photo.photo_id, new Map());
    return;
  }

  const model     = await aiModelRepo.findByCategoryId(categoryId);
  const projectId = model?.customvision_project_id ?? null;

  if (!customVisionService.isConfigured() || !projectId) {
    console.warn(`[annotationSync] Custom Vision no configurado o sin proyecto para categoría ${categoryId} — se omite sync de regiones (photo_id=${photo.photo_id})`);
    return;
  }

  // Hoisted fuera del try (no `const` adentro) para que el catch de abajo pueda intentar
  // limpiarlo si el tag se creó recién en esta llamada y el resto del sync falló después —
  // ver el catch más abajo (Fix 2026-08-09, mismo incidente que motivó
  // modelTrainingService.purgeEmptyTags(), acá la mitad "preventiva").
  let tagId = null;
  // Hoisted igual que tagId — el catch necesita correlacionar err.partialCreated contra la
  // misma lista que se mandó a crear (Fix 2026-08-09, F1.1/Fase 2).
  let regionsToCreate = [];

  try {
    // pendingSync ya filtró todo lo que tenía cv_region_id, así que esto es un no-op hoy —
    // se deja por si en el futuro un cv_region_id "huérfano" (sin fila SYNCED) llegara a colarse.
    await deleteOldRegions(projectId, pendingSync);

    tagId = await resolveTagId(projectId, photo.canal);

    // Auto-registro defensivo (Opción C) si la foto llegó sin cvImageId — ver
    // autoRegisterImage() para el porqué (desconexión con #42).
    let cvImageId = photo.cv_image_id ?? extractCvImageId(photo.photo_notes);
    if (!cvImageId) {
      cvImageId = await autoRegisterImage(photo, projectId, tagId);
    }

    regionsToCreate = pendingSync.filter(r =>
      r.bbox_left != null && r.bbox_top != null && r.bbox_width != null && r.bbox_height != null
    );

    // FIX 2026-08-09 (F1.1/Fase 2 — fallo parcial de batch): createImageRegions trocea en
    // lotes de 64 vía llamadas HTTP INDEPENDIENTES, sin atomicidad del lado de Custom Vision
    // entre lotes (confirmado en Tarea 0). Antes, si una foto tenía más de 64 cajitas y el
    // SEGUNDO lote fallaba, las regiones del PRIMER lote — ya reales y confirmadas en CV — se
    // perdían por completo (el `created` acumulado nunca llegaba hasta acá), dejando la foto
    // sin ese cv_region_id; el próximo reintento las volvía a enviar y CV respondía "Duplicate
    // image regions", atascando la foto en ERROR para siempre. `onBatchCreated` persiste cada
    // lote confirmado INMEDIATAMENTE, antes de intentar el siguiente — así un fallo a mitad de
    // camino nunca pierde lo que ya es real en Custom Vision, y además reduce (no elimina del
    // todo) la ventana de "se creó en CV pero el proceso murió antes de guardar en SQL" a la
    // duración de un solo lote en vez de la sincronización completa.
    const confirmedByAnnotation = new Map();
    await customVisionService.createImageRegions(
      projectId,
      regionsToCreate.map(r => ({
        imageId: cvImageId,
        tagId,
        left:    r.bbox_left,
        top:     r.bbox_top,
        width:   r.bbox_width,
        height:  r.bbox_height,
      })),
      {
        onBatchCreated: async (chunkCreated) => {
          const { cvRegionIdsByAnnotation, unmatched } = correlateCreatedRegions(regionsToCreate, chunkCreated);
          if (unmatched.length) {
            console.warn(`[annotationSync] ${unmatched.length} región(es) de un lote de photo_id=${photo.photo_id} no matchearon por coordenadas con ninguna anotación pendiente`);
          }
          await persistRegionIds(cvRegionIdsByAnnotation);
          for (const [annotationId, regionId] of cvRegionIdsByAnnotation.entries()) {
            confirmedByAnnotation.set(annotationId, regionId);
          }
        },
      }
    );

    // Segundo agujero de F1.1: CV puede confirmar MENOS regiones que las enviadas SIN lanzar
    // ningún error. Antes esto solo logueaba un warning y de todas formas marcaba la foto
    // entera SYNCED — esas cajitas quedaban sin cv_region_id para siempre, porque una foto
    // SYNCED no se vuelve a sincronizar sola. Ahora: lo confirmado ya quedó persistido arriba
    // (nunca se pierde ni se reenvía), pero la foto se marca ERROR, no SYNCED, para que un
    // reintento futuro complete lo que falta.
    if (confirmedByAnnotation.size < regionsToCreate.length) {
      const missing = regionsToCreate.length - confirmedByAnnotation.size;
      console.warn(`[annotationSync] photo_id=${photo.photo_id}: sync incompleto (${confirmedByAnnotation.size}/${regionsToCreate.length} confirmadas) — foto marcada ERROR, no SYNCED`);
      await markFailed(photo.photo_id, new Error(
        `Custom Vision confirmó ${confirmedByAnnotation.size}/${regionsToCreate.length} regiones — ${missing} sin match de coordenadas.`
      ));
      return;
    }

    await trainingPhotoRepo.updateCvSync(photo.photo_id, { syncStatus: 'SYNCED', syncError: null });
    console.log(`[annotationSync] photo_id=${photo.photo_id}: ${confirmedByAnnotation.size} regiones sincronizadas a Custom Vision (proyecto=${projectId})`);
  } catch (err) {
    console.error(`[annotationSync] fallo al sincronizar photo_id=${photo.photo_id} con Custom Vision:`, err.message);

    // Defensa en profundidad: si un lote lanzó (ver createImageRegions), lo confirmado en
    // lotes ANTERIORES a ese ya se persistió vía onBatchCreated — esto solo cubre el caso de
    // que err.partialCreated traiga algo que por lo que fuera no llegó a pasar por ahí.
    if (err.partialCreated?.length) {
      const { cvRegionIdsByAnnotation } = correlateCreatedRegions(regionsToCreate, err.partialCreated);
      if (cvRegionIdsByAnnotation.size) await persistRegionIds(cvRegionIdsByAnnotation);
    }

    await markFailed(photo.photo_id, err);
    await cleanupTagIfOrphaned(projectId, tagId, photo.photo_id);
  }
}

// Fix 2026-08-09 — mitad PREVENTIVA del fix de tags vacíos (la mitad defensiva vive en
// modelTrainingService.purgeEmptyTags(), justo antes de cada intento de training; esta acá
// intenta arreglarlo en el momento en que se produce, no solo antes del próximo training).
// Causa real confirmada en category_id=2: resolveTagId()/ensureTag() crea el tag ANTES de que
// createImageRegions() confirme al menos una región — si algo falla entre esas dos líneas
// (autoRegisterImage, red, "Duplicate image regions", etc.), el tag queda huérfano con 0
// imágenes. Re-consulta el tag por id (no confía en el imageCount que trajo ensureTag() al
// momento de crearlo, que siempre es 0 recién creado) — si sigue en 0, es señal de que esta
// llamada lo dejó huérfano y es seguro borrarlo; si ya tiene imágenes (otra foto del mismo
// canal sí llegó a sincronizar antes), NO se toca.
async function cleanupTagIfOrphaned(projectId, tagId, photoId) {
  if (!tagId) return;
  try {
    const tags = await customVisionService.listTags(projectId);
    const tag = tags.find(t => t.id === tagId);
    if (tag && (tag.imageCount ?? 0) === 0) {
      console.warn(`[annotationSync] tag "${tag.name}" (id=${tagId}) quedó sin imágenes tras el fallo de sync de photo_id=${photoId} — eliminándolo para no tumbar el próximo training`);
      await customVisionService.deleteTag(projectId, tagId);
    }
  } catch (err2) {
    console.error(`[annotationSync] no se pudo verificar/limpiar el tag ${tagId} tras el fallo de photo_id=${photoId} (queda para que lo limpie purgeEmptyTags antes del próximo training):`, err2.message);
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

    const cvImageId = photo.cv_image_id ?? extractCvImageId(photo.photo_notes);
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

// Cableado 2026-08-03 (spec v1.4, 4.3) — Verifica, canal por canal, si una categoría alcanzó
// el umbral de fotos SINCRONIZADAS (cv_sync_status='SYNCED') para disparar entrenamiento
// automático. El conteo es "desde el último entrenamiento" (`model.trained_at`, avanzado por
// aiModelRepo.markTrained() al completar un training — ver modelTrainingService.js): si el
// modelo nunca entrenó, cuenta todas las SYNCED (equivale al "primera vez, 15" de la spec);
// si ya entrenó antes, solo cuenta las sincronizadas DESPUÉS de esa fecha (equivale al "+15
// acumuladas desde el último entrenamiento" — evita re-disparar con las mismas fotos que ya
// entrenaron una vez).
//
// Al llegar a CUALQUIER canal con ≥ umbral: se marca IMAGES_UPLOADED (guardia de estado que
// `modelTrainingService.startTraining()` ya exige) y se dispara el training de inmediato,
// fire-and-forget (no bloquea el sync que llamó a esta función) — entrena el PROYECTO
// completo (todos los canales/tags juntos), no solo el canal que cruzó el umbral, porque
// `trainProject()` opera sobre el proyecto CV entero, no por tag (spec 4.3: "20 OMT + 15 DTT
// → entrena con las 35").
//
// NOTA (residual, no resuelto en este cableado): la spec 4.3 también pide que un training
// fallido (`Failed` en Custom Vision) vuelva el modelo a PENDING para poder reintentarse sin
// bloquear — `modelTrainingService.pollTrainingStatus()` hoy solo marca `TRAINING_FAILED` y
// se detiene ahí (comportamiento preexistente a este cableado, no tocado). Como
// TRAINING_FAILED no está en SKIP_THRESHOLD_STATUSES, un sync posterior SÍ vuelve a evaluar
// el umbral con normalidad (usando el mismo `trained_at` de antes del intento fallido, que no
// avanzó), así que en la práctica un reintento eventual ocurre en cuanto llegue una foto más
// — pero no hay un reintento inmediato/explícito. Documentado como gap conocido, no como bug
// de esta pasada.
async function checkAndUpdateThreshold(categoryId) {
  const model = await aiModelRepo.findByCategoryId(categoryId);
  if (!model) {
    console.warn(`[annotationSync] no hay modelo activo para categoría ${categoryId} — se omite verificación de umbral`);
    return;
  }

  if (SKIP_THRESHOLD_STATUSES.has(model.status)) {
    console.log(`[annotationSync] modelo de categoría ${categoryId} ya está en estado ${model.status} — no se reevalúa umbral (training en curso)`);
    return;
  }

  const threshold = THRESHOLD();
  for (const canal of CANALES) {
    const count = await trainingPhotoRepo.countSyncedSinceByCategoryChannel(categoryId, canal, model.trained_at);
    if (count >= threshold) {
      console.log(`[annotationSync] umbral alcanzado — categoria=${categoryId} canal=${canal} (${count}/${threshold} SYNCED desde trained_at=${model.trained_at ?? 'nunca'}) → disparando entrenamiento automático`);
      await aiModelRepo.updateStatus(model.detection_model_id, 'IMAGES_UPLOADED');

      // Fire-and-forget — no se espera a que termine el training, el sync que llamó a esta
      // función ya completó su trabajo. modelTrainingService.startTraining() vuelve a leer el
      // modelo fresco de BD (ya en IMAGES_UPLOADED) y sigue el mismo camino que antes tenía el
      // endpoint manual retirado — ver docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md.
      modelTrainingService.startTraining(categoryId, null)
        .catch(err => console.error(`[annotationSync] disparo automático de training falló (categoria=${categoryId}):`, err.message));
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

  // clienteAjustoCajitas=false solo es honrado si HAY algo sincronizado que preservar — ver
  // NOTA de cabecera (bug 2026-08-05: el flag se aceptaba ciegamente y una primera aprobación
  // con clienteAjustoCajitas=false dejaba la foto en cv_sync_status='PENDING' para siempre,
  // sin ningún log). splitByCvRegionId ya existe y la usa syncRegionsForPhoto — se reusa acá,
  // no se reimplementa.
  let didSync = false;
  if (clienteAjustoCajitas === false) {
    const { alreadySynced } = splitByCvRegionId(rows);
    if (alreadySynced.length > 0) {
      console.log(`[annotationSync] photo_id=${photoId}: sync omitido — clienteAjustoCajitas=false y ${alreadySynced.length}/${rows.length} cajita(s) ya sincronizada(s) con Custom Vision`);
    } else {
      console.warn(`[annotationSync] photo_id=${photoId}: clienteAjustoCajitas=false pero NINGUNA cajita tiene cv_region_id (nunca se sincronizó) — se ignora el flag y se sincroniza igual`);
      await syncRegionsForPhoto(photo, rows);
      didSync = true;
    }
  } else {
    await syncRegionsForPhoto(photo, rows);
    didSync = true;
  }

  await checkAndUpdateThreshold(photo.category_id);
  return { synced: didSync };
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
