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
//     (y evaluarEntrenamiento) puede resolver el modelo equivocado. Considerar un índice
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
const modelProvider       = require('./modelProvider'); // ciclo 5 (A4): único acceso a Custom Vision
const modelTrainingService = require('./modelTrainingService');
const blobStorageService  = require('./blobStorageService');
const configService        = require('./configService');
const { hashBuffer }       = require('../utils/imageHasher');
const categoryRepo         = require('../repositories/categoryRepo');
const { toCvTagName }      = require('../utils/categoryNameNormalizer');
const aiInfrastructureService = require('./aiInfrastructureService');
const { prepareForCustomVision } = require('../utils/customVisionImagePrep');


// Ciclo 5 (A3) — los DOS umbrales del entrenamiento automático viven en RETSC_CONFIG (editables
// sin deploy). Antes el primero salía de la env SHELF_TRAINING_THRESHOLD y el código y la
// configuración estaban desconectados (pendiente desde agosto). Lectura con
// configService.getNumberConfig(): cache corto + fallback + parseo seguro.
//
//   FIRST_TRAIN_MIN_PHOTOS — primer entrenamiento: fotos APROBADAS + SYNCED de la categoría
//     (todos los canales). 15 es además el MÍNIMO TÉCNICO de Custom Vision para detección
//     (15 imágenes por tag; con un solo tag por categoría, 15 fotos lo cumplen) — por eso
//     min: 15, un valor menor en RETSC_CONFIG se ignora (Custom Vision rechazaría el training).
//   RETRAIN_BATCH_SIZE — reentrenamiento: fotos nuevas aprobadas desde trained_at (decisión
//     del 11-ago: 5).
const FIRST_TRAIN_MIN_PHOTOS_KEY      = 'FIRST_TRAIN_MIN_PHOTOS';
const FIRST_TRAIN_MIN_PHOTOS_FALLBACK = 15;
const RETRAIN_BATCH_SIZE_KEY          = 'RETRAIN_BATCH_SIZE';
const RETRAIN_BATCH_SIZE_FALLBACK     = 5;

// Mismo container que usa shelfPhotoUploadService.js — necesario acá para el auto-registro
// defensivo (Opción C, ver autoRegisterImage()).
const SHELF_CONTAINER = () =>
  process.env.AZURE_GLOBAL_SHELF_CONTAINER || 'global-shelf-training';

// Estados en los que evaluarEntrenamiento() NO dispara: ya hay un entrenamiento en marcha.
//   · TRAINING — Custom Vision entrenando (~20 min de polling en modelTrainingService).
//   · IMAGES_UPLOADED — una aprobación ya tomó el modelo (aiModelRepo.claimForTraining) y está
//     llamando a trainProject. Ciclo 5 (A3): la carga de fotos (Etapa 8 de
//     shelfPhotoUploadService) YA NO marca este estado — antes lo hacía sin entrenar y dejaba el
//     modelo trabado aquí para siempre. Los modelos que quedaron así se destraban con
//     migrations/017_reset_modelos_trabados_images_uploaded.sql.
// PUBLISHED / TRAINED / TRAINING_FAILED NO bloquean: el conteo "desde trained_at" ya evita
// re-disparar con las mismas fotos, y un fallo se reintenta en la próxima aprobación.
const SKIP_THRESHOLD_STATUSES = new Set(['TRAINING', 'IMAGES_UPLOADED']);

// Issue #35 (resuelto 2026-08-03, cableado spec v1.4) — antes esto leía CV_TAG_OMT/DTT/
// CONVENIENCE (env vars globales, un solo tag id para TODAS las categorías del canal —
// incorrecto en cuanto hay más de un proyecto CV activo). Ahora resuelve el tag DENTRO del
// proyecto de la categoría vía modelProvider.asegurarTag() (lista tags del proyecto, crea
// si no existe, reusa si ya está — no duplica).
// Ciclo 5 (A2): el tag es la CATEGORÍA, no el canal. 1 proyecto CV = 1 categoría = 1 tag.
// El canal queda solo en RETSC_AI_TRAINING_PHOTOS.canal y no viaja a Custom Vision.
// Nombre del tag: toCvTagName() — ej. "Desodorantes Corporales" → "DESODORANTES_CORPORALES".
async function resolveTagId(projectId, categoryId) {
  const category = await categoryRepo.findById(categoryId);
  if (!category) throw new Error(`categoría ${categoryId} no existe — no se puede resolver el tag`);
  const tag = await modelProvider.asegurarTag(projectId, toCvTagName(category.Category_dsc));
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

// Desde 2026-08-12 este es el camino NORMAL: la subida (shelfPhotoUploadService.js) ya solo
// escribe en Blob Storage + BD, con cv_image_id=null — el registro real en Custom Vision se
// hace ACÁ, al sincronizar la anotación aprobada, momento en el que el proyecto de la
// categoría ya existe con certeza (si no existiera, no habría nada para anotar/aprobar) y el
// tag se resuelve con modelProvider.asegurarTag(), la misma fuente de verdad que el resto
// del pipeline de sync usa. Antes esto era una mitigación excepcional (Opción C, 2026-08-05)
// solo para fotos insertadas directo a Blob/SQL sin pasar por uploadShelfPhoto (desconexión
// #42, Arthur) — ese caso sigue funcionando igual acá, simplemente ya no es la excepción.
//
// Descarga el blob, lo sube a Custom Vision, y persiste el id en su columna propia
// (trainingPhotoRepo.updateCvImageId — Issue #3) para que un sync futuro de la misma foto no
// tenga que volver a registrarla (idempotente por diseño: solo se llama cuando la foto no
// tiene ya un cv_image_id real).
//
// Solo es posible si la foto tiene blob_path Y el blob existe de verdad en
// AZURE_GLOBAL_SHELF_CONTAINER — si no, se deja que la excepción se propague al catch de
// syncRegionsForPhoto (mismo mecanismo de siempre: marca cv_sync_status='ERROR' con mensaje
// claro, no rompe el resto de la corrida).
//
// NO se llama si Custom Vision no está configurado / sin proyecto — ese caso ya corta antes,
// en el guard de isConfigured()/projectId de syncRegionsForPhoto, así que acá siempre hay un
// projectId válido y CV configurado.
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

  // El hash es SIEMPRE el de la original (la que está en el blob), no el de la copia reducida.
  const hash = await hashBuffer(buffer);

  // Ciclo 5 (A1): Custom Vision acepta máx. 6 MB por imagen. La original queda en el blob; a
  // CV va una copia reducida si hace falta (las cajitas son 0..1, no se mueven).
  const prepared = await prepareForCustomVision(buffer);
  if (prepared.resized) {
    console.log(`[annotationSync] photo_id=${photo.photo_id}: imagen de ${(prepared.originalBytes / 1048576).toFixed(1)} MB reducida a ${(prepared.finalBytes / 1048576).toFixed(1)} MB para Custom Vision (la original queda en el blob)`);
  }
  const { cvImageId } = await modelProvider.subirImagen(projectId, prepared.buffer, tagId);

  // Se guarda en las COLUMNAS propias (Issue #3), no concatenado en photo_notes:
  // esa columna quedó reservada para el motivo/comentario de la revisión.
  await trainingPhotoRepo.updateCvImageId(photo.photo_id, cvImageId, hash);

  console.log(
    `[annotationSync] photo_id=${photo.photo_id} registrada en Custom Vision al sincronizar ` +
    `(camino normal desde 2026-08-12) — cvImageId=${cvImageId}`
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
    await modelProvider.borrarRegion(projectId, regionId);
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
    // nada. evaluarEntrenamiento cuenta por cv_sync_status='SYNCED' a nivel de foto, así
    // que esto bloqueaba el disparo automático de entrenamiento con datos que en Custom
    // Vision ya estaban completos. Encontrado con category_id=2/OMT: 15 fotos con el 100% de
    // sus cajitas ya sincronizadas (710 anotaciones, todas con cv_region_id) pero
    // cv_sync_status='PENDING' en la foto. markSynced(photoId, new Map()) no reenvía nada
    // (mapa vacío → el loop de arriba no itera nada), solo asienta cv_sync_status='SYNCED'.
    console.log(`[annotationSync] photo_id=${photo.photo_id}: todas las anotaciones ya estaban sincronizadas — nada que enviar a Custom Vision`);
    await markSynced(photo.photo_id, new Map());
    return;
  }

  let model     = await aiModelRepo.findByCategoryId(categoryId);
  let projectId = model?.customvision_project_id ?? null;

  // Ciclo 5 (A2.4): categoría sin proyecto CV al aprobar su primera foto (ej. el provisioning
  // al crear la categoría falló o no había credenciales) → se reintenta acá con el mismo
  // retryForCategory() del endpoint POST /api/categories/:id/retry-ai-infra: crea la fila en
  // RETSC_AI_DETECTION_MODELS si falta (insert manda confidence_threshold=0.5 por default)
  // y el proyecto Object Detection si el modelo sigue PENDING. Si falla, se sigue el camino
  // de siempre (warn + omitir), nunca bloquea la aprobación.
  if (modelProvider.estaConfigurado() && !projectId) {
    try {
      const r = await aiInfrastructureService.retryForCategory(categoryId);
      console.log(`[annotationSync] categoría ${categoryId} sin proyecto CV — provisioning reintentado: ${r.status}${r.errors?.length ? ' (' + r.errors.join('; ') + ')' : ''}`);
      model     = await aiModelRepo.findByCategoryId(categoryId);
      projectId = model?.customvision_project_id ?? null;
    } catch (err) {
      console.warn(`[annotationSync] no se pudo provisionar el proyecto CV de la categoría ${categoryId}:`, err.message);
    }
  }

  if (!modelProvider.estaConfigurado() || !projectId) {
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

    tagId = await resolveTagId(projectId, categoryId);

    // FIX 2026-08-12: un cv_image_id que empieza con 'stub-' NO es una imagen real de Custom
    // Vision — lo generaba shelfPhotoUploadService.createImageFromData cuando la categoría
    // todavía no tenía proyecto en CV (modelo PENDING/PROJECT_CREATED). Tratarlo como "no
    // registrada" para que autoRegisterImage() la suba de verdad desde el blob. Esto hace que
    // las fotos ya atascadas con un stub se auto-reparen en el próximo sync, sin tocar la BD
    // a mano. (La subida ya no genera stubs desde este mismo fix — ver shelfPhotoUploadService.js
    // — pero fotos subidas ANTES del fix pueden tener uno guardado.)
    let cvImageId = photo.cv_image_id ?? extractCvImageId(photo.photo_notes);
    if (cvImageId && String(cvImageId).startsWith('stub-')) {
      console.warn(`[annotationSync] photo_id=${photo.photo_id} tenía cv_image_id stub (${cvImageId}) — se re-registra en Custom Vision desde el blob.`);
      cvImageId = null;
    }
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
    await modelProvider.crearRegiones(
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
    const tags = await modelProvider.listarTags(projectId);
    const tag = tags.find(t => t.id === tagId);
    if (tag && (tag.imageCount ?? 0) === 0) {
      console.warn(`[annotationSync] tag "${tag.name}" (id=${tagId}) quedó sin imágenes tras el fallo de sync de photo_id=${photoId} — eliminándolo para no tumbar el próximo training`);
      await modelProvider.borrarTag(projectId, tagId);
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

  if (!modelProvider.estaConfigurado() || !projectId) {
    console.warn(`[annotationSync] Custom Vision no configurado o sin proyecto para categoría ${categoryId} — se omite limpieza de CV (photo_id=${photo.photo_id})`);
    return;
  }

  try {
    await deleteOldRegions(projectId, rows);

    // Mismo guard anti-stub que en syncRegionsForPhoto (FIX 2026-08-12): un id 'stub-...'
    // nunca existió de verdad en Custom Vision — no tiene sentido pedirle a la API que borre
    // algo que nunca creó (y CV lo rechazaría igual).
    const cvImageId = photo.cv_image_id ?? extractCvImageId(photo.photo_notes);
    if (cvImageId && !String(cvImageId).startsWith('stub-')) {
      await modelProvider.borrarImagenes(projectId, [cvImageId]);
    }

    // cv_region_id queda en null tras el borrado; no hubo regiones nuevas que crear.
    await markSynced(photo.photo_id, new Map());
    console.log(`[annotationSync] photo_id=${photo.photo_id}: regiones/imagen eliminadas de Custom Vision (SQL conservado)`);
  } catch (err) {
    console.error(`[annotationSync] fallo al limpiar photo_id=${photo.photo_id} en Custom Vision:`, err.message);
    await markFailed(photo.photo_id, err);
  }
}

// Ciclo 5 (A3) — ÚNICA función de disparo del entrenamiento automático. La llaman la
// aprobación individual (syncApprovedPhoto) y la masiva (annotationController.approvePhotosBatch,
// una vez por lote al final). Reemplaza a checkAndUpdateThreshold (que contaba POR CANAL y
// disparaba fire-and-forget).
//
//   1. Modelo en TRAINING/IMAGES_UPLOADED → no hace nada (ya hay uno en curso).
//   2. Cuenta fotos APROBADAS + SYNCED de la CATEGORÍA (todos los canales suman):
//        · primer entrenamiento (trained_at NULL): todas  ≥ FIRST_TRAIN_MIN_PHOTOS (15)
//        · reentrenamiento: aprobadas después de trained_at ≥ RETRAIN_BATCH_SIZE (5)
//   3. Toma el modelo con aiModelRepo.claimForTraining() (UPDATE atómico): si dos aprobaciones
//      llegan a la vez, solo una dispara.
//   4. await startTraining() (trainProject en Custom Vision). El polling de los ~20 min sigue
//      en background dentro de modelTrainingService, que graba cualquier fallo en BD.
//   5. Si algo falla → TRAINING_FAILED + motivo en last_training_error (nunca queda colgado
//      en IMAGES_UPLOADED). TRAINING_FAILED no bloquea: la próxima aprobación reintenta.
//
// NUNCA lanza: la aprobación ya quedó persistida y no debe responder 500 por esto. Devuelve
// { triggered, reason, count, threshold } para logs/tests.
async function evaluarEntrenamiento(categoryId) {
  try {
    if (categoryId == null) {
      console.warn('[annotationSync] evaluarEntrenamiento sin categoryId — se omite');
      return { triggered: false, reason: 'SIN_CATEGORIA' };
    }

    const model = await aiModelRepo.findByCategoryId(categoryId);
    if (!model) {
      console.warn(`[annotationSync] no hay modelo activo para categoría ${categoryId} — se omite evaluación de entrenamiento`);
      return { triggered: false, reason: 'SIN_MODELO' };
    }
    if (SKIP_THRESHOLD_STATUSES.has(model.status)) {
      console.log(`[annotationSync] categoría ${categoryId}: modelo en ${model.status} — entrenamiento ya en curso, no se reevalúa`);
      return { triggered: false, reason: 'EN_CURSO' };
    }

    const isFirstTraining = model.trained_at == null;
    const threshold = isFirstTraining
      ? await configService.getNumberConfig(FIRST_TRAIN_MIN_PHOTOS_KEY, FIRST_TRAIN_MIN_PHOTOS_FALLBACK, { min: FIRST_TRAIN_MIN_PHOTOS_FALLBACK })
      : await configService.getNumberConfig(RETRAIN_BATCH_SIZE_KEY, RETRAIN_BATCH_SIZE_FALLBACK, { min: 1 });
    const count = await trainingPhotoRepo.countSyncedSinceByCategory(categoryId, isFirstTraining ? null : model.trained_at);
    const tipo  = isFirstTraining ? 'primer entrenamiento' : `reentrenamiento (desde ${model.trained_at?.toISOString?.() ?? model.trained_at})`;

    if (count < threshold) {
      console.log(`[annotationSync] categoría ${categoryId}: ${count}/${threshold} fotos para ${tipo} — todavía no entrena`);
      return { triggered: false, reason: 'BAJO_UMBRAL', count, threshold };
    }

    const claimed = await aiModelRepo.claimForTraining(model.detection_model_id);
    if (!claimed) {
      console.log(`[annotationSync] categoría ${categoryId}: otra aprobación ya tomó el modelo para entrenar — no se duplica`);
      return { triggered: false, reason: 'EN_CURSO', count, threshold };
    }

    console.log(`[annotationSync] categoría ${categoryId}: ${count}/${threshold} fotos para ${tipo} → disparando entrenamiento automático`);
    try {
      const r = await modelTrainingService.startTraining(categoryId, null);
      return { triggered: true, count, threshold, ...r };
    } catch (err) {
      // startTraining ya graba TRAINING_FAILED si Custom Vision rechaza trainProject; se repite
      // acá (idempotente) para cubrir fallos ANTES de esa llamada (guardias, red, etc.) — así el
      // modelo nunca se queda en IMAGES_UPLOADED, que bloquearía todos los intentos futuros.
      console.error(`[annotationSync] no se pudo iniciar el entrenamiento (categoria=${categoryId}):`, err.message);
      await aiModelRepo.markTrainingFailed(model.detection_model_id, err.message)
        .catch(e2 => console.error('[annotationSync] además, no se pudo marcar TRAINING_FAILED:', e2.message));
      return { triggered: false, reason: 'FALLO', error: err.message, count, threshold };
    }
  } catch (err) {
    console.error(`[annotationSync] error evaluando entrenamiento (categoria=${categoryId}):`, err.message);
    return { triggered: false, reason: 'ERROR', error: err.message };
  }
}

// Punto de entrada tras aprobar la foto (photo_status='APROBADA' ya persistido en
// RETSC_AI_TRAINING_PHOTOS por trainingPhotoRepo.approvePhoto).
//
// OPCIÓN B — PENDIENTE DE EVALUAR (decisión de Arthur, 2026-08-12)
//
// Hoy aprobar sincroniza de inmediato: el revisor espera a que las cajitas suban
// a Custom Vision antes de que la petición responda. La alternativa es DESACOPLAR
// las dos cosas — aprobar sólo marca el estado, y un proceso aparte recoge las
// aprobadas y las sincroniza en tanda (cada N minutos, o al juntar N fotos).
//
// A favor: la aprobación responde al instante sin importar cuántas cajitas tenga
// la foto; se agrupan los envíos y las verificaciones de umbral aunque el revisor
// apruebe de a una; un fallo de Custom Vision deja de bloquear al revisor.
//
// En contra: hace falta un job y una política de reintentos; el estado deja de
// ser inmediato (una foto puede quedar APROBADA con cv_sync_status PENDING un
// rato, y la UI tiene que explicarlo); y cambia el comportamiento que QA acaba de
// validar.
//
// Se dejó para después de probar el lote en uso real: puede que agrupando la
// aprobación ya alcance y no valga la pena el job. Si se implementa, el punto de
// corte natural es acá — syncApprovedPhoto pasaría a ser lo que llama el job en
// vez de lo que llama el controller.
//
// `skipThresholdCheck` existe para la aprobación EN LOTE: entrenar cuesta lo
// mismo con 10 fotos que con 40, así que el gasto no depende de cuántas cajitas
// se mandan sino de cuántas VECES se entrena. Verificando el umbral una vez por
// foto, un lote de 10 lo evalúa 10 veces; quien aprueba en lote lo pasa en true y
// llama a evaluarEntrenamiento() UNA sola vez al final.
async function syncApprovedPhoto(photoId, { clienteAjustoCajitas, skipThresholdCheck = false } = {}) {
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

  if (!skipThresholdCheck) await evaluarEntrenamiento(photo.category_id);
  return { synced: didSync, categoryId: photo.category_id };
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
  // Ciclo 5 (A3): única función de disparo — la usa también approvePhotosBatch.
  evaluarEntrenamiento,
  // Alias por compatibilidad (nombre anterior) — no usar en código nuevo.
  checkAndUpdateThreshold: evaluarEntrenamiento,
};
