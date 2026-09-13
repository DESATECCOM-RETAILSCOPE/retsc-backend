// Pasos 1 + 2 de la guía "Fotos de Visita" v1.9 — guarda una foto de visita YA validada por
// el mobile (blur/luz/encuadre OK) en Blob Storage y la registra en RETSC_EX_SHELFPHOTO,
// amarrada al Visit_id abierto en el Paso 0. Dispara el Paso 3+ (detección) en background.
//
// ⚠ Reformulación del DBA (confirmada en vivo, 2026-08-07): RETSC_EX_SHELFPHOTO ahora tiene
// User_id NOT NULL (columna nueva) y una FK compuesta (Visit_id, User_id, Enterprise_id,
// Retailer_id) → RETSC_EX_VISIT (mismas 4 columnas) — las 4 deben coincidir exactamente con
// la fila de la visita, no solo con valores "razonables". Shelfunit_id también pasó a ser
// NOT NULL (antes opcional). Por eso acá abajo: (a) shelfunitId ya no es opcional — 400 si
// falta, igual que categoryId; (b) se valida que uploadedBy sea el dueño de la visita ANTES
// de insertar, para dar un 403 legible en vez de que la FK compuesta lo rechace con un error
// de SQL crudo si algún día uploadedBy != visit.User_id.
//
// Distinto de shelfPhotoUploadService.js (fotos GLOBALES de entrenamiento, sin enterprise,
// sin visita, con su propio gate de calidad de 8 etapas — Issues 7.1/7.2): este es el flujo
// de PRODUCCIÓN, una foto por enterprise/PDV/visita real. La guía es explícita (sección 3):
// "La foto llega al backend YA validada por el mobile (blur, luz, encuadre) — aquí no se
// vuelve a validar eso, solo se guarda" — a propósito NO se usa imageQualityValidator para
// RECHAZAR una foto acá (el mobile sigue siendo quien decide aceptar/rechazar, vía
// quality_status en el body). quality_status llega tal cual del mobile y se guarda como
// registro de auditoría (ver guía, Paso 2).
//
// PERO quality_error_code/width/height/blur_score/brightness sí se calculan acá (2026-08-29)
// reusando imageQualityValidator — el mismo validador basado en sharp que ya usa el flujo de
// entrenamiento — porque el mobile no puede calcular nitidez/brillo reales en JS puro (ver
// NOTA en src/utils/imageQuality.js del repo del mobile: ahí blurScore/brightness siempre
// viajan null). Antes esta función guardaba quality_error_code/width/height como null fijo
// y blur_score/brightness como lo que mandara el mobile (o sea, también null en la práctica)
// — la migración 005 pensaba estos campos para calibrar los umbrales con datos reales de
// producción, y con eso siempre null nunca hubo nada que calibrar. El cálculo de calidad es
// puramente informativo acá: si falla (buffer corrupto, etc.) se loguea y se sigue con
// valores null, nunca se aborta la subida por esto.
//
// NOTA: la guía no pide un paso de deduplicación por hash para este flujo (a diferencia del
// de entrenamiento). Igual se calcula y guarda image_hash — la columna ya existe en
// RETSC_EX_SHELFPHOTO y es información de auditoría gratis — pero no se usa para rechazar
// la subida.

const crypto = require('crypto');

const { uploadToContainer }    = require('./blobStorageService');
const { hashBuffer }           = require('../utils/imageHasher');
const { validateImageQuality } = require('../utils/imageQualityValidator');
const visitRepo             = require('../repositories/visitRepo');
const categoryRepo          = require('../repositories/categoryRepo');
const enterpriseRepo        = require('../repositories/enterpriseRepo');
const retailerRepo          = require('../repositories/retailerRepo');
const shelfPhotoRepo        = require('../repositories/shelfPhotoRepo');
const detectionPipelineService = require('./detectionPipelineService');

// Convierte una descripción de catálogo (nombre de empresa, PDV, categoría) en un segmento
// de ruta de blob storage seguro: sin acentos, sin caracteres que Azure Blob no permite en
// nombres de blob (/, \, etc. quedarían como separadores de carpeta si no se limpian), sin
// espacios. Si la descripción no está disponible (catálogo caído, id sin match), usa el
// fallback para no tumbar la subida de la foto por un nombre bonito.
function pathSegment(description, fallback) {
  if (!description) return fallback;
  const clean = description
    .toString()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

const VISIT_SHELF_CONTAINER = () =>
  process.env.AZURE_VISIT_SHELF_CONTAINER || 'enterprise-shelf-visits';

function svcError(message, statusCode, errorCode) {
  return Object.assign(new Error(message), { statusCode, errorCode });
}

function parseIntOrThrow(value, label, errorCode) {
  const n = parseInt(value, 10);
  if (isNaN(n)) throw svcError(`${label} es requerido y debe ser un número entero.`, 400, errorCode);
  return n;
}

// Mismo orden de prioridad que shelfPhotoQualityService.js (ERROR_PRIORITY), sin
// DUPLICATE_IMAGE — este flujo no hace dedup, quality_error_code es una sola columna así
// que si fallan varios criterios de píxeles se reporta el primero según esta prioridad.
const QUALITY_ERROR_PRIORITY = ['LOW_RESOLUTION', 'BLURRY_IMAGE', 'POOR_LIGHTING'];

function firstQualityError(errors) {
  for (const code of QUALITY_ERROR_PRIORITY) {
    if (errors.includes(code)) return code;
  }
  return errors[0] ?? null;
}

// Calcula resolución/nitidez/brillo reales del buffer ya en memoria. Puramente
// informativo — nunca lanza ni bloquea la subida: si sharp no puede decodificar la
// imagen (buffer corrupto, formato raro), se loguea y se sigue con todo en null.
async function computeQualityMetrics(buffer) {
  try {
    const { errors, metrics } = await validateImageQuality(buffer);
    return {
      errorCode: firstQualityError(errors),
      width:     metrics.width,
      height:    metrics.height,
      blurScore: metrics.sharpness,
      brightness: metrics.brightness,
    };
  } catch (err) {
    console.warn(`[visitPhoto] no se pudieron calcular métricas de calidad — ${err.message}`);
    return { errorCode: null, width: null, height: null, blurScore: null, brightness: null };
  }
}

// @param buffer         - contenido de la imagen (ya leído del archivo multer)
// @param visitId        - Visit_id devuelto al abrir la visita (Paso 0)
// @param categoryId     - categoría seleccionada en el mobile para ESTA foto
// @param shelfunitId    - REQUERIDO (RETSC_EX_SHELFPHOTO.Shelfunit_id es NOT NULL en la BD)
// @param qualityStatus  - veredicto PASSED/REJECTED ya decidido por el mobile (Paso 3, guía)
// @param blurScore, brightness - LEGACY, ya no se usan para guardar (ver computeQualityMetrics
//   arriba) — se siguen aceptando en la firma para no romper si algún caller viejo los manda,
//   pero se ignoran a favor del cálculo real hecho acá con el buffer.
async function uploadVisitPhoto({ buffer, visitId, categoryId, shelfunitId, qualityStatus, uploadedBy }) {
  const visitIdInt     = parseIntOrThrow(visitId, 'visitId', 'ERR_VISIT_ID_REQUERIDO');
  const categoryIdInt  = parseIntOrThrow(categoryId, 'categoryId', 'ERR_CATEGORIA_REQUERIDA');
  const shelfunitIdInt = parseIntOrThrow(shelfunitId, 'shelfunitId', 'ERR_SHELFUNIT_REQUERIDO');

  const visit = await visitRepo.findById(visitIdInt);
  if (!visit) {
    throw svcError(`Visita ${visitIdInt} no encontrada.`, 404, 'ERR_VISITA_NO_ENCONTRADA');
  }
  if (visit.Status !== 'OPEN') {
    throw svcError(`La visita ${visitIdInt} ya está ${visit.Status} — no se pueden agregar más fotos.`, 409, 'ERR_VISITA_CERRADA');
  }
  if (visit.User_id !== uploadedBy) {
    // La FK compuesta (Visit_id, User_id, Enterprise_id, Retailer_id) → RETSC_EX_VISIT lo
    // rechazaría igual a nivel de BD, pero con un error de SQL crudo — este chequeo da un
    // 403 legible antes de llegar ahí.
    throw svcError('No puedes agregar fotos a la visita de otro usuario.', 403, 'ERR_VISITA_AJENA');
  }

  const category = await categoryRepo.findById(categoryIdInt);
  if (!category) {
    throw svcError(`Categoría ${categoryIdInt} no encontrada.`, 404, 'ERR_CATEGORIA_NO_ENCONTRADA');
  }

  console.log(`[visitPhoto] inicio carga — visit_id=${visitIdInt}, categoría=${categoryIdInt} (${category.Category_dsc}), uploadedBy=${uploadedBy}`);

  // Path de blob storage con descripciones legibles en vez de ids crudos (a pedido del
  // equipo — la guía v1.9 sección 3.1 originalmente pedía enterprise_id/pdv_id/session_id/
  // category_id). Enterprise_dsc y Retailer_dsc requieren una consulta extra a sus
  // catálogos; category_id ya se resolvió arriba (category.Category_dsc). La visita no
  // tiene una descripción propia en RETSC_EX_VISIT — se usa fecha + Visit_id
  // (ej. "2026-08-18_visit-142") para que sea legible y no choque si dos visitas abren
  // el mismo día al mismo PDV. Cada segmento cae a su id crudo si el catálogo no resuelve
  // (retailerRepo.findById degrada a null si RETSC_OP_RETAILER no existe — ver ese archivo).
  const [hash, quality, enterprise, retailer] = await Promise.all([
    hashBuffer(buffer),
    computeQualityMetrics(buffer),
    enterpriseRepo.findById(visit.Enterprise_id),
    retailerRepo.findById(visit.Retailer_id),
  ]);

  const enterpriseFolder = pathSegment(enterprise?.Enterprise_dsc, `enterprise-${visit.Enterprise_id}`);
  const retailerFolder   = pathSegment(retailer?.Retailer_dsc, `retailer-${visit.Retailer_id}`);
  const categoryFolder   = pathSegment(category.Category_dsc, `category-${categoryIdInt}`);
  const visitDateStr     = (visit.Visit_start ? new Date(visit.Visit_start) : new Date()).toISOString().slice(0, 10);
  const visitFolder      = `${visitDateStr}_visit-${visit.Visit_id}`;

  const filename = `${Math.floor(Date.now() / 1000)}-${crypto.randomUUID().slice(0, 8)}.jpg`;
  const blobPath = `${enterpriseFolder}/${retailerFolder}/${visitFolder}/${categoryFolder}/${filename}`;

  const { url: blobUrl } = await uploadToContainer({
    containerName: VISIT_SHELF_CONTAINER(),
    blobPath,
    buffer,
    contentType: 'image/jpeg',
  });

  console.log(`[visitPhoto] blob subido — path=${blobPath}`);

  const photo = await shelfPhotoRepo.insert({
    retailer_id:        visit.Retailer_id,
    user_id:            uploadedBy,
    shelfunit_id:        shelfunitIdInt,
    photo_date:         new Date(),
    url_blob:           blobUrl,
    enterprise_id:      visit.Enterprise_id,
    category_id:        categoryIdInt,
    visit_id:           visitIdInt,
    image_hash:         hash,
    quality_status:     qualityStatus ?? null,
    quality_error_code: quality.errorCode,
    width:              quality.width,
    height:             quality.height,
    blur_score:         quality.blurScore,
    brightness:         quality.brightness,
  });

  const photoId = photo.Photo_id;
  console.log(`[visitPhoto] foto registrada — Photo_id=${photoId}`);

  // Pasos 3-5 (detección + identificación de producto) corren en background — el mobile ya
  // tiene su photoId y no necesita esperar a Custom Vision/OCR/búsqueda de SKU para el 201.
  // Mismo patrón fire-and-forget que aiInfrastructureService.provisionForCategory().
  setImmediate(() => {
    detectionPipelineService.processPhotoDetection(photoId, buffer, categoryIdInt)
      .catch(err => console.error(`[visitPhoto] Photo_id=${photoId} — error en pipeline de detección:`, err.message));
  });

  return {
    photoId,
    visitId: visitIdInt,
    categoryId: categoryIdInt,
    blobPath,
    blobUrl,
  };
}

module.exports = { uploadVisitPhoto };
