// Servicio orquestador para la carga de fotos de góndola globales (Issue 7.2).
//
// Flujo actual (la Etapa 6 original —registro en Custom Vision— se ELIMINÓ, ver FIX
// 2026-08-12 más abajo):
//   1. Validaciones de entrada (canal, dtcCategoryId, archivo)
//   2a. Calidad de píxeles (resolución/nitidez/brillo) — local con sharp
//   2b. Caption confidence — Azure AI Vision (stub permisivo hasta que haya credenciales)
//   3.  Validación de contenido ("¿es una góndola?") — Azure AI Vision (stub permisivo)
//   4.  Deduplicación por hash SHA-256 (scope global: ENTERPRISE_ID IS NULL)
//   5.  Upload a Blob Storage SIEMPRE, un archivo por canal (FIX 2026-08-05)
//   7.  Insert en RETSC_AI_TRAINING_PHOTOS, con cv_image_id=null (FIX 2026-07-26 / 2026-08-12)
//   8.  Verificación de umbral por canal (no bloquea la subida)
//
// FIX 2026-08-12: esta subida ya NO registra la imagen en Custom Vision (Etapa 6 eliminada).
// Antes, createImageFromData() se llamaba acá mismo con la categoría recién validada — pero si
// el modelo todavía estaba en PENDING/PROJECT_CREATED (sin proyecto CV real), esa función
// devolvía un id FALSO (`stub-<uuid>`) que se persistía como si fuera un cvImageId real. Al
// aprobar la anotación, el sync confiaba en ese id y Custom Vision lo rechazaba con
// "BadRequestInvalidIds". Ahora la foto queda SOLO en Blob Storage + BD con
// `cv_image_id=null`; el registro real en Custom Vision lo hace
// annotationSyncService.autoRegisterImage() en el momento de sincronizar la anotación
// aprobada — ahí el proyecto ya existe con certeza (si no existiera, no habría nada para
// anotar) y el tag se resuelve con customVisionService.ensureTag(), la misma fuente de verdad
// que usa el resto del pipeline de sync (antes esta subida usaba su propio resolveTagId() vía
// env vars CV_TAG_OMT/DTT/CONVENIENCE, vacías siempre — dos fuentes de verdad distintas para lo
// mismo; ahora solo queda la de ensureTag()).
//
// FIX 2026-08-12 (separado): este flujo NO toca RETSC_EX_SHELFPHOTO — esa tabla es de EJECUCIÓN
// de otro equipo (Carlos), no de entrenamiento; se usaba antes como "libro de hashes" para el
// dedup y nunca debió tocarse (ver Etapa 4 más abajo para el detalle del incidente que esto
// arregló).
//
// FIX 2026-07-26 (migración de esquema del equipo DBA): la Etapa 7 insertaba una fila
// "placeholder" en RETSC_AI_TRAINING_ANNOTATIONS con photo_notes/canal/dtc_category_id —
// esas columnas se movieron a la tabla nueva RETSC_AI_TRAINING_PHOTOS (una fila por foto;
// RETSC_AI_TRAINING_ANNOTATIONS ahora es solo cajitas, FK'd a esta por photo_id). La Etapa 7
// ahora inserta en RETSC_AI_TRAINING_PHOTOS y YA NO crea ninguna anotación — no hay cajitas
// que crear al momento de subir la foto (eso lo hace el equipo de anotación, Issue #42,
// externo a este repo).
//
// La foto es GLOBAL: no pertenece a ningún enterprise. Alimenta el modelo de
// DETECCIÓN (dónde hay producto en góndola), no el de identificación de GTIN.
//
// Dependencias externas pendientes:
//   - AZURE_VISION_ENDPOINT / AZURE_VISION_KEY (Image Analysis stub activo)
//
// TODOs:
//   - Activar analyzeCaption() e isShelf() cuando Azure Vision tenga credenciales

const { validateQualityMetrics } = require('./shelfPhotoQualityService');
const azureVisionService          = require('./azureVisionService');
const { uploadToContainer }       = require('./blobStorageService');
const { hashBuffer }              = require('../utils/imageHasher');
const { generateFilename }        = require('../utils/shelfPhotoFilenameGenerator');
const { normalizeName }           = require('../utils/categoryNameNormalizer');
const categoryRepo                = require('../repositories/categoryRepo');
const trainingPhotoRepo           = require('../repositories/trainingPhotoRepo');
const aiModelRepo                 = require('../repositories/aiModelRepo');

const CANALES_VALIDOS = ['OMT', 'DTT', 'CONVENIENCE'];

const SHELF_CONTAINER = () =>
  process.env.AZURE_GLOBAL_SHELF_CONTAINER || 'global-shelf-training';

const CAPTION_MIN_CONFIDENCE = () =>
  parseFloat(process.env.QUALITY_CAPTION_MIN_CONFIDENCE || '0.6');

const TRAINING_THRESHOLD = () =>
  parseInt(process.env.SHELF_TRAINING_THRESHOLD || '15', 10);

function svcError(message, statusCode, errorCode) {
  return Object.assign(new Error(message), { statusCode, errorCode });
}

// Orquesta las 8 etapas de la carga. Recibe el buffer ya leído del archivo multer.
// Lanzar antes de llamar: leer buffer, validar formato/tamaño en la ruta.
//
// @param {Buffer} buffer          - Contenido de la imagen
// @param {number} dtcCategoryId   - ID de la categoría DTC smart
// @param {string} canal           - 'OMT' | 'DTT' | 'CONVENIENCE'
// @param {number} uploadedBy      - req.user.userId (auditoría)
// @returns {object}               - Datos de la subida para la respuesta HTTP
async function uploadShelfPhoto({ buffer, dtcCategoryId, canal, uploadedBy, enterpriseId = null }) {

  // ── Etapa 1: Validaciones de entrada ────────────────────────────────────────

  if (!canal) {
    throw svcError('El campo canal es requerido.', 400, 'ERR_CANAL_REQUERIDO');
  }
  if (!CANALES_VALIDOS.includes(canal)) {
    throw svcError(
      `Canal inválido. Valores aceptados: ${CANALES_VALIDOS.join(', ')}.`,
      400, 'ERR_CANAL_INVALIDO'
    );
  }

  const dtcId = parseInt(dtcCategoryId, 10);
  if (!dtcId || isNaN(dtcId)) {
    throw svcError('dtcCategoryId es requerido y debe ser un número entero.', 400, 'ERR_CATEGORIA_REQUERIDA');
  }

  const category = await categoryRepo.findById(dtcId);
  if (!category) {
    throw svcError(`Categoría ${dtcId} no encontrada.`, 404, 'ERR_CATEGORIA_NO_ENCONTRADA');
  }
  if (!category.is_smart_dtc) {
    throw svcError(
      `La categoría ${dtcId} no es una categoría inteligente DTC (is_smart_dtc=0).`,
      400, 'ERR_CATEGORIA_NO_SMART'
    );
  }

  console.log(`[shelfPhoto] inicio carga — categoría=${dtcId} (${category.Category_dsc}), canal=${canal}, uploadedBy=${uploadedBy}`);

  // ── Etapa 2a: Calidad de píxeles ─────────────────────────────────────────────
  // validateQualityMetrics no hace dedup (ese paso es Etapa 4 con scope global).

  const quality = await validateQualityMetrics(buffer);
  if (!quality.accepted) {
    console.warn(`[shelfPhoto] calidad rechazada — errorCode=${quality.errorCode}`);
    throw svcError(
      `La imagen no cumple los criterios de calidad: ${quality.errorCode}.`,
      422, quality.errorCode
    );
  }

  // ── Etapa 2b: Caption confidence (Azure AI Vision) ───────────────────────────

  const captionResult = await azureVisionService.analyzeCaption(buffer);
  if (!captionResult.stub && captionResult.confidence < CAPTION_MIN_CONFIDENCE()) {
    throw svcError(
      `Confianza de caption insuficiente (${captionResult.confidence.toFixed(2)} < ${CAPTION_MIN_CONFIDENCE()}).`,
      422, 'ERR_LOW_CAPTION_CONFIDENCE'
    );
  }

  // ── Etapa 3: Validación de contenido (¿es una góndola?) ──────────────────────

  const shelfResult = await azureVisionService.isShelf(buffer);
  if (!shelfResult.stub && !shelfResult.isShelf) {
    throw svcError(
      'La imagen no fue reconocida como una foto de góndola de supermercado.',
      422, 'ERR_NOT_A_SHELF'
    );
  }

  // ── Etapa 4: Deduplicación por hash SHA-256, CONSCIENTE DE CANAL (fix Issue B4) ──
  // NOTA: el issue dice "MD5" como referencia informal, pero el repo y la columna
  // image_hash VarChar(64) usan SHA-256. Se reutiliza SHA-256 por consistencia.
  //
  // FIX 2026-07-26: antes se rechazaba CUALQUIER imagen con un hash ya visto, sin
  // importar el canal — así que la misma foto subida para OMT y después para DTT se
  // rechazaba como duplicada en el segundo canal, y ese canal nunca se guardaba. La
  // regla correcta es "una vez por canal", no "una vez globalmente".
  //
  // FIX 2026-08-12: el dedup se hace SOLO contra RETSC_AI_TRAINING_PHOTOS (columna propia
  // image_hash + canal). Antes se consultaba e insertaba en RETSC_EX_SHELFPHOTO — la tabla de
  // EJECUCIÓN de OTRO equipo (Carlos) — como "libro de hashes" cruzado con esta tabla; este
  // flujo de entrenamiento nunca debió tocarla. Ese otro equipo cambió el esquema de esa tabla
  // (quitó/renombró Retailer_id) y el INSERT de acá reventaba con "Invalid column name
  // 'Retailer_id'" — como ese INSERT ocurría ANTES de la Etapa 7, la foto ni siquiera llegaba
  // a RETSC_AI_TRAINING_PHOTOS. Ahora (hash, canal) se resuelve por completo en esta tabla,
  // sin cruzar con la de Carlos.
  const hash = quality.hash; // ya calculado por validateQualityMetrics

  const alreadyInThisChannel = await trainingPhotoRepo.findByHashAndCanal(hash, canal);
  if (alreadyInThisChannel) {
    throw Object.assign(
      new Error(`Esta foto ya fue subida antes para el canal ${canal}. Si es una foto distinta, verificá que no sea exactamente el mismo archivo (mismo contenido de imagen).`),
      { statusCode: 409, errorCode: 'ERR_DUPLICATE_IMAGE', existingPhotoId: alreadyInThisChannel.photo_id }
    );
  }

  // ── Etapa 5: Upload a Blob Storage, SIEMPRE ──────────────────────────────────
  // FIX 2026-08-05 (decisión de producto, María): el blob se sube SIEMPRE a la carpeta del
  // canal ACTUAL, exista o no el hash en otro canal (un archivo por canal) — la Etapa 4 ya
  // garantiza que solo llega hasta acá si (hash, canal) todavía no existe.
  const categoriaSlug = normalizeName(category.Category_dsc);
  const filename      = generateFilename({ categoriaSlug, canal });
  const blobPath      = `dtc-${categoriaSlug}/${canal.toLowerCase()}/${filename}`;

  const uploadResult = await uploadToContainer({
    containerName: SHELF_CONTAINER(),
    blobPath,
    buffer,
    contentType: 'image/jpeg',
  });
  const blobUrl = uploadResult.url;
  console.log(`[shelfPhoto] blob subido — path=${blobPath} (mode=${uploadResult.mode})`);

  if (uploadResult.mode !== 'azure') {
    console.warn(
      `[shelfPhoto] ⚠ uploadToContainer corrió en mode='${uploadResult.mode}', NO 'azure'. ` +
      `El blob NO llegó al contenedor de Azure. Revisar BLOB_STORAGE_MODE / connection string en Railway.`
    );
  }

  // FIX 2026-08-12: ya NO se inserta en RETSC_EX_SHELFPHOTO (tabla de ejecución de otro equipo).
  // El registro de la foto de entrenamiento vive únicamente en RETSC_AI_TRAINING_PHOTOS (Etapa 7).

  // ── Etapa 6: (eliminada) Registro en Custom Vision ───────────────────────────
  // FIX 2026-08-12: la subida ya NO registra la imagen en Custom Vision. Antes, si la
  // categoría no tenía proyecto todavía (modelo PENDING/PROJECT_CREATED), createImageFromData
  // devolvía un id FALSO (`stub-<uuid>`) que se persistía en cv_image_id; al aprobar, el sync
  // lo tomaba como válido y Custom Vision respondía BadRequestInvalidIds. Ahora la foto va
  // SOLO al Blob Storage (Etapa 5) + BD (Etapa 7), y el registro en Custom Vision lo hace
  // annotationSyncService.autoRegisterImage() al sincronizar, descargando el blob — momento en
  // el que el proyecto ya existe con certeza y el tag se resuelve con ensureTag().

  // ── Etapa 7: Insert en RETSC_AI_TRAINING_PHOTOS ──────────────────────────────
  // Sin cajitas todavía (status inicial EN_PROGRESO) — las crea el equipo de anotación
  // (Issue #42, externo).

  // Cada dato en SU columna (Issue #3 de QA). Antes esto era un solo string
  // concatenado en photo_notes — "blob:... | sha256:... | cvImageId:..." — que
  // obligaba a parsear con regex para leerlo y dejaba a photo_notes sin poder
  // usarse para lo suyo. `blob_path`, `image_hash` y `cv_image_id` ya tienen
  // columna propia, así que photo_notes queda LIBRE para el motivo/comentario
  // real de la revisión.
  const trainingPhoto = await trainingPhotoRepo.insert({
    uploaded_by_user_id: uploadedBy,
    // De qué contribuyente vino la foto. Es lo que habilita el aislamiento por
    // empresa del modo REVIEW (guía 3.1): que cada admin revise sólo las suyas.
    // Sin esto la columna queda en NULL y ese filtro no puede funcionar.
    uploaded_by_enterprise_id: enterpriseId ?? null,
    category_id:         dtcId,
    canal,
    blob_path:            blobPath,
    image_hash:           hash,
    cv_image_id:          null,   // lo completa annotationSyncService al sincronizar
    photo_notes:          null,
    photo_status:         'EN_PROGRESO',
  });

  const trainingPhotoId = trainingPhoto.photo_id;
  console.log(`[shelfPhoto] foto de entrenamiento registrada — photo_id=${trainingPhotoId}`);

  // ── Etapa 8: Verificar umbral por canal (no bloquea la subida) ───────────────
  // NOTA: 'IMAGES_UPLOADED' es un status nuevo para el modelo; la columna status
  // es varchar(20) y lo soporta. Indica que hay imágenes suficientes para entrenar.
  // `model` se resuelve acá (ya no en la Etapa 6, que se eliminó) — es lo único que
  // todavía necesita aiModelRepo en este flujo.

  const model = await aiModelRepo.findByCategoryId(dtcId);
  const channelCount = await trainingPhotoRepo.countValidatedApprovedByCategoryChannel(dtcId, canal);
  const threshold    = TRAINING_THRESHOLD();
  const thresholdReached = channelCount >= threshold;

  if (thresholdReached && model) {
    await aiModelRepo.updateStatus(model.detection_model_id, 'IMAGES_UPLOADED')
      .catch(err => console.warn(`[shelfPhoto] no se pudo actualizar status del modelo:`, err.message));
    console.log(`[shelfPhoto] umbral alcanzado (${channelCount}/${threshold}) — modelo marcado IMAGES_UPLOADED`);
  }

  return {
    photoId: trainingPhotoId,
    blobPath,
    blobUrl,
    blobMode: uploadResult.mode,
    cvImageId: null,   // se registra en Custom Vision al aprobar la anotación, no al subir
    canal,
    dtcCategoryId: dtcId,
    channelCount,
    thresholdReached,
  };
}

module.exports = { uploadShelfPhoto };
