// Servicio orquestador para la carga de fotos de góndola globales (Issue 7.2).
//
// Implementa el flujo de 8 etapas definido en el issue:
//   1. Validaciones de entrada (canal, dtcCategoryId, archivo)
//   2a. Calidad de píxeles (resolución/nitidez/brillo) — local con sharp
//   2b. Caption confidence — Azure AI Vision (stub permisivo hasta que haya credenciales)
//   3.  Validación de contenido ("¿es una góndola?") — Azure AI Vision (stub permisivo)
//   4.  Deduplicación por hash SHA-256 (scope global: ENTERPRISE_ID IS NULL)
//   5.  Upload a Blob Storage SIEMPRE (un archivo por canal, FIX 2026-08-05) + insert en
//       RETSC_EX_SHELFPHOTO solo si el hash es nuevo (evita violar su índice único)
//   6.  Registro en Custom Vision SIN regiones → cvImageId
//   7.  Insert en RETSC_AI_TRAINING_PHOTOS (FIX 2026-07-26 — ver nota más abajo)
//   8.  Verificación de umbral por canal (no bloquea la subida)
//
// FIX 2026-07-26 (migración de esquema del equipo DBA): la Etapa 7 insertaba una fila
// "placeholder" en RETSC_AI_TRAINING_ANNOTATIONS con photo_notes/canal/dtc_category_id —
// esas columnas se movieron a la tabla nueva RETSC_AI_TRAINING_PHOTOS (una fila por foto;
// RETSC_AI_TRAINING_ANNOTATIONS ahora es solo cajitas, FK'd a esta por photo_id). La Etapa 7
// ahora inserta en RETSC_AI_TRAINING_PHOTOS y YA NO crea ninguna anotación — no hay cajitas
// que crear al momento de subir la foto (eso lo hace el equipo de anotación, Issue #42,
// externo a este repo). El photo_id que importa para el pipeline de review/anotación es el
// de RETSC_AI_TRAINING_PHOTOS, DISTINTO del Photo_id de RETSC_EX_SHELFPHOTO (Etapa 5) — no
// hay FK entre esas dos tablas, son namespaces de ID separados.
//
// La foto es GLOBAL: no pertenece a ningún enterprise. Alimenta el modelo de
// DETECCIÓN (dónde hay producto en góndola), no el de identificación de GTIN.
//
// Dependencias externas pendientes:
//   - AZURE_VISION_ENDPOINT / AZURE_VISION_KEY (Image Analysis stub activo)
//   - CUSTOM_VISION_TRAINING_KEY / CUSTOM_VISION_ENDPOINT (stub activo)
//   - CV_TAG_OMT / CV_TAG_DTT / CV_TAG_CONVENIENCE (Issue #35 — tagId por canal)
//
// TODOs:
//   - Conectar tagId de Custom Vision por canal cuando llegue Issue #35
//   - Activar analyzeCaption() e isShelf() cuando Azure Vision tenga credenciales

const { validateQualityMetrics } = require('./shelfPhotoQualityService');
const azureVisionService          = require('./azureVisionService');
const customVisionService         = require('./customVisionService');
const { uploadToContainer }       = require('./blobStorageService');
const { hashBuffer }              = require('../utils/imageHasher');
const { generateFilename }        = require('../utils/shelfPhotoFilenameGenerator');
const { normalizeName }           = require('../utils/categoryNameNormalizer');
const categoryRepo                = require('../repositories/categoryRepo');
const shelfPhotoRepo              = require('../repositories/shelfPhotoRepo');
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

// Resuelve el tagId de Custom Vision para un canal dado.
// Por ahora viene de env opcionales; si no están configurados, devuelve null.
// TODO: reemplazar por lookup a tabla de tags de Custom Vision cuando llegue Issue #35.
function resolveTagId(canal) {
  const map = {
    OMT:         process.env.CV_TAG_OMT,
    DTT:         process.env.CV_TAG_DTT,
    CONVENIENCE: process.env.CV_TAG_CONVENIENCE,
  };
  return map[canal] || null;
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
  // RETSC_EX_SHELFPHOTO no tiene columna `canal` (el dedup original era global a
  // propósito, antes de que existiera el concepto de canal en este flujo) y
  // RETSC_AI_TRAINING_PHOTOS no tiene columna `image_hash` propia (el hash sigue
  // viajando en photo_notes, mismo TEMPORAL de siempre) — ninguna de las dos tablas
  // tiene por sí sola (hash, canal) juntos. Se resuelve cruzando ambas sin migrar nada:
  //   1. ¿Existe ALGUNA fila en RETSC_EX_SHELFPHOTO con este hash? (bytes ya vistos)
  //   2. Si existe, ¿ya hay una fila en RETSC_AI_TRAINING_PHOTOS con este hash PARA
  //      ESTE canal? → 409 duplicado real (mismo canal, misma imagen).
  //   3. Si existe el hash pero NO para este canal → se sube igual un blob nuevo bajo la
  //      carpeta de ESTE canal (FIX 2026-08-05, ver Etapa 5) — solo se evita el segundo
  //      INSERT en RETSC_EX_SHELFPHOTO, que violaría su índice único por (hash, NULL).
  const hash = quality.hash; // ya calculado por validateQualityMetrics

  const existingHash = await shelfPhotoRepo.findByHashGlobal(hash);

  if (existingHash) {
    const alreadyInThisChannel = await trainingPhotoRepo.findByHashAndCanal(hash, canal);
    if (alreadyInThisChannel) {
      throw Object.assign(
        new Error(`Esta foto ya fue subida antes para el canal ${canal}. Si es una foto distinta, verificá que no sea exactamente el mismo archivo (mismo contenido de imagen).`),
        { statusCode: 409, errorCode: 'ERR_DUPLICATE_IMAGE', existingPhotoId: alreadyInThisChannel.photo_id }
      );
    }
    console.log(`[shelfPhoto] hash ya visto (Photo_id=${existingHash.Photo_id}) pero no para canal=${canal} — se sube igual un blob nuevo para este canal (Etapa 5)`);
  }

  // ── Etapa 5: Upload a Blob Storage (SIEMPRE) + insert en RETSC_EX_SHELFPHOTO (condicional) ──
  // FIX 2026-08-05 (decisión de producto, María): el blob se sube SIEMPRE a la carpeta del
  // canal ACTUAL, exista o no el hash en otro canal (un archivo por canal). Antes, si el hash
  // ya existía, se saltaba el upload y se copiaba el blob_path del canal viejo → dos bugs:
  // (a) fila en BD sin blob, y (b) canal=OMT con blob_path bajo /dtt/. Ahora solo el registro
  // de dedup por hash en RETSC_EX_SHELFPHOTO es condicional: su índice único filtrado
  // (ENTERPRISE_ID, image_hash) trata dos NULL como iguales, así que un segundo INSERT con el
  // mismo hash violaría la constraint. Subir el mismo buffer a un blob_path DISTINTO (otra
  // carpeta de canal) no viola nada. Efecto deseado: aunque RETSC_EX_SHELFPHOTO tenga hashes
  // viejos de pruebas, la carga vuelve a llegar al contenedor sin limpiar esa tabla a mano.
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

  if (!existingHash) {
    await shelfPhotoRepo.insert({
      enterprise_id:      null,            // foto global, sin enterprise
      category_id:        dtcId,
      url_blob:           blobUrl,
      photo_date:         new Date(),
      image_hash:         hash,
      quality_status:     'PASSED',
      quality_error_code: null,
      width:              quality.metrics.width,
      height:             quality.metrics.height,
      blur_score:         quality.metrics.sharpness,
      brightness:         quality.metrics.brightness,
    });
  } else {
    console.log(
      `[shelfPhoto] hash ya visto (Photo_id=${existingHash.Photo_id}) — no se re-inserta en ` +
      `RETSC_EX_SHELFPHOTO (dedup por hash), pero el blob del canal ${canal} sí quedó subido en ${blobPath}`
    );
  }

  // ── Etapa 6: Registro en Custom Vision SIN regiones ──────────────────────────
  // projectId puede ser null si la categoría aún no tiene modelo en Custom Vision (PENDING).
  // En ese caso createImageFromData devuelve stub con ID simulado.

  const model     = await aiModelRepo.findByCategoryId(dtcId);
  const projectId = model?.customvision_project_id ?? null;
  const tagId     = resolveTagId(canal);

  const { cvImageId } = await customVisionService.createImageFromData(projectId, buffer, tagId);
  console.log(`[shelfPhoto] Custom Vision — cvImageId=${cvImageId}`);

  // ── Etapa 7: Insert en RETSC_AI_TRAINING_PHOTOS ──────────────────────────────
  // Sin cajitas todavía (status inicial EN_PROGRESO) — las crea el equipo de anotación
  // (Issue #42, externo). photo_notes sigue llevando el mismo resumen de trazabilidad
  // de siempre (blob + hash + cvImageId), ahora en la fila de FOTO en vez de en una
  // anotación placeholder.

  const photoNotes = `blob:${blobPath} | sha256:${hash} | cvImageId:${cvImageId}`;
  const trainingPhoto = await trainingPhotoRepo.insert({
    uploaded_by_user_id: uploadedBy,
    // De qué contribuyente vino la foto. Es lo que habilita el aislamiento por
    // empresa del modo REVIEW (guía 3.1): que cada admin revise sólo las suyas.
    // Sin esto la columna queda en NULL y ese filtro no puede funcionar.
    uploaded_by_enterprise_id: enterpriseId ?? null,
    category_id:         dtcId,
    canal,
    blob_path:            blobPath,
    photo_notes:          photoNotes,
    photo_status:         'EN_PROGRESO',
  });

  const trainingPhotoId = trainingPhoto.photo_id;
  console.log(`[shelfPhoto] foto de entrenamiento registrada — photo_id=${trainingPhotoId}`);

  // ── Etapa 8: Verificar umbral por canal (no bloquea la subida) ───────────────
  // NOTA: 'IMAGES_UPLOADED' es un status nuevo para el modelo; la columna status
  // es varchar(20) y lo soporta. Indica que hay imágenes suficientes para entrenar.

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
    cvImageId,
    canal,
    dtcCategoryId: dtcId,
    channelCount,
    thresholdReached,
  };
}

module.exports = { uploadShelfPhoto };
