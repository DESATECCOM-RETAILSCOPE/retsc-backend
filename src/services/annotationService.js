// Servicio de revisión de anotaciones de góndola (Issue 7.5).
//
// Aprobar, corregir o rechazar anotaciones (bounding boxes) antes de enviarlas a
// Custom Vision. Solo roles autorizados pueden invocar estas acciones — eso se
// controla en la capa de rutas con requireRole.
//
// Acciones:
//   approve  → is_validated = 1
//   correct  → coordenadas + is_validated = 1
//   reject   → elimina el registro
//
// Reglas (Issue 7.5):
//   - Mínimo 1 anotación por foto: no se permite rechazar la ÚLTIMA anotación de una
//     foto (la dejaría sin nada que entrenar). Para descartar una foto entera va otro
//     flujo. El "mínimo 1 VALIDADA" se consulta con getPhotoReadiness antes de enviar
//     la foto a Custom Vision.
//   - Las rechazadas se eliminan físicamente.
//
// NOTA: se asume que las coordenadas vienen NORMALIZADAS [0,1] (formato de Azure
// Custom Vision, coherente con la columna cv_region_id). Si el generador de
// anotaciones las llenara en píxeles, ajustar validateBbox y/o COORD_MAX.

const annotationRepo = require('../repositories/annotationRepo');

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

// Valida un bounding box normalizado [0,1]. Lanza 400 si algo está fuera de rango.
function validateBbox(bbox) {
  const fields = ['bbox_left', 'bbox_top', 'bbox_width', 'bbox_height'];
  for (const f of fields) {
    const v = bbox?.[f];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw httpError(`Coordenada inválida: ${f} debe ser un número.`, 400);
    }
  }
  const { bbox_left: l, bbox_top: t, bbox_width: w, bbox_height: h } = bbox;
  if (l < 0 || t < 0 || l > 1 || t > 1) {
    throw httpError('bbox_left y bbox_top deben estar en el rango [0, 1].', 400);
  }
  if (w <= 0 || h <= 0 || w > 1 || h > 1) {
    throw httpError('bbox_width y bbox_height deben estar en (0, 1].', 400);
  }
  if (l + w > 1 || t + h > 1) {
    throw httpError('El bounding box se sale del marco (left+width o top+height > 1).', 400);
  }
}

async function getOrThrow(id) {
  const ann = await annotationRepo.findById(id);
  if (!ann) throw httpError(`Anotación ${id} no encontrada.`, 404);
  return ann;
}

// APROBAR
async function approve(id, reviewerId) {
  await getOrThrow(id);
  return annotationRepo.approve(id, reviewerId);
}

// CORREGIR
async function correct(id, bbox, reviewerId) {
  await getOrThrow(id);
  validateBbox(bbox);
  return annotationRepo.correct(id, bbox, reviewerId);
}

// RECHAZAR (eliminar). Bloquea si es la última anotación de la foto.
async function reject(id) {
  const ann = await getOrThrow(id);
  const total = await annotationRepo.countByPhoto(ann.photo_id);
  if (total <= 1) {
    throw httpError(
      'No se puede rechazar la última anotación de la foto. Una foto debe conservar al menos una anotación; para descartar la foto completa usá el flujo de rechazo de foto.',
      409,
    );
  }
  await annotationRepo.remove(id);
  return { deleted: true, annotationId: id, photoId: ann.photo_id };
}

// Estado de la foto para Custom Vision: ¿tiene al menos 1 anotación validada?
async function getPhotoReadiness(photoId) {
  const total = await annotationRepo.countByPhoto(photoId);
  const validated = await annotationRepo.countValidatedByPhoto(photoId);
  return { photoId, total, validated, ready: validated >= 1 };
}

module.exports = { approve, correct, reject, getPhotoReadiness, validateBbox };
