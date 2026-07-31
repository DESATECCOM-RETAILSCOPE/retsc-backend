// RETSC_AI_TRAINING_ANNOTATIONS — cajitas (bounding boxes) de fotos de góndola para el
// entrenamiento de Custom Vision. Una fila por cajita, enlazada a su foto por photo_id.
//
// FIX 2026-07-26 — migración de esquema del equipo DBA: los campos a nivel de FOTO
// (photo_notes, canal, dtc_category_id/category_id, blob_path, aprobación,
// cv_sync_status/error/attempts) se movieron a la tabla nueva RETSC_AI_TRAINING_PHOTOS
// (ver src/repositories/trainingPhotoRepo.js). Esta tabla dejó de tener esas columnas —
// el código seguía leyéndolas/escribiéndolas y todo lo que las tocaba fallaba con
// "Invalid column name" (esquema real verificado con INFORMATION_SCHEMA).
//
// Esquema real HOY (confirmado con INFORMATION_SCHEMA, 2026-07-26):
//   annotation_id (PK), photo_id (FK → RETSC_AI_TRAINING_PHOTOS.photo_id),
//   bbox_left, bbox_top, bbox_width, bbox_height (float),
//   source (varchar), is_validated (bit), created_at, cv_region_id (varchar).
// YA NO EXISTEN acá: dtc_category_id, canal, photo_approved, photo_notes,
// photo_reviewer_id, photo_reviewed_at, cv_sync_status, cv_sync_error, cv_sync_attempts.
//
// Acciones del Issue 7.5 (por cajita individual):
//   APROBAR  → is_validated = 1
//   CORREGIR → coordenadas + is_validated = 1
//   RECHAZAR → eliminar el registro
// El reviewer/fecha de revisión de una cajita individual YA NO se persiste acá — esas
// columnas (photo_reviewer_id/photo_reviewed_at) no existen más en esta tabla; la
// aprobación con reviewer+fecha ahora es a nivel de FOTO (trainingPhotoRepo.approvePhoto).

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_AI_TRAINING_ANNOTATIONS';

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE annotation_id = @id`);
  return r.recordset[0] ?? null;
};

const listByPhoto = async (photoId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId', sql.Int, photoId)
    .query(`SELECT * FROM ${TABLE} WHERE photo_id = @photoId ORDER BY annotation_id`);
  return r.recordset;
};

// APROBAR una cajita individual. reviewerId se mantiene como parámetro por compatibilidad
// de firma con annotationService/annotationController, pero ya no se persiste acá — no hay
// columna de reviewer a nivel de cajita en el esquema real (ver header).
const approve = async (id, reviewerId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      UPDATE ${TABLE}
      SET    is_validated = 1
      OUTPUT INSERTED.*
      WHERE  annotation_id = @id
    `);
  return r.recordset[0] ?? null;
};

// CORREGIR coordenadas de una cajita individual + marcar validada. Mismo comentario que
// approve() sobre reviewerId.
const correct = async (id, bbox, reviewerId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',       sql.Int,   id)
    .input('left',     sql.Float, bbox.bbox_left)
    .input('top',      sql.Float, bbox.bbox_top)
    .input('width',    sql.Float, bbox.bbox_width)
    .input('height',   sql.Float, bbox.bbox_height)
    .query(`
      UPDATE ${TABLE}
      SET    bbox_left   = @left,
             bbox_top    = @top,
             bbox_width  = @width,
             bbox_height = @height,
             is_validated = 1
      OUTPUT INSERTED.*
      WHERE  annotation_id = @id
    `);
  return r.recordset[0] ?? null;
};

// Marca TODAS las cajitas de una foto como validadas de una sola vez. Antes esto vivía
// combinado en un único approvePhoto() que además marcaba photo_approved=1 en esta misma
// tabla; ese flag ahora vive en RETSC_AI_TRAINING_PHOTOS (trainingPhotoRepo.approvePhoto) —
// el controller llama a las dos funciones. Devuelve las filas de anotación actualizadas.
const validateAllByPhoto = async (photoId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId', sql.Int, photoId)
    .query(`
      UPDATE ${TABLE}
      SET    is_validated = 1
      OUTPUT INSERTED.*
      WHERE  photo_id = @photoId
    `);
  return r.recordset;
};

// RECHAZAR: elimina el registro. Devuelve cuántas filas se borraron.
const remove = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`DELETE FROM ${TABLE} WHERE annotation_id = @id`);
  return r.rowsAffected[0];
};

// Total de anotaciones de una foto (para la regla "mínimo 1 por foto").
const countByPhoto = async (photoId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId', sql.Int, photoId)
    .query(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE photo_id = @photoId`);
  return r.recordset[0].n;
};

// Anotaciones VALIDADAS de una foto (para el readiness antes de Custom Vision).
const countValidatedByPhoto = async (photoId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId', sql.Int, photoId)
    .query(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE photo_id = @photoId AND is_validated = 1`);
  return r.recordset[0].n;
};

// Fotos NUEVAS con anotación validada para una categoría desde la última fecha de
// entrenamiento (Issue 8.5, regla "mínimo 20 fotos nuevas para re-entrenar"). category_id
// ahora vive en RETSC_AI_TRAINING_PHOTOS, de ahí el JOIN (antes era dtc_category_id directo
// en esta misma tabla). Si sinceDate es null (modelo nunca entrenado), cuenta todas.
const countNewValidatedPhotos = async (categoryId, sinceDate) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int,      categoryId)
    .input('since',      sql.DateTime, sinceDate ?? null)
    .query(`
      SELECT COUNT(DISTINCT a.photo_id) AS n
      FROM ${TABLE} a
      JOIN RETSC_AI_TRAINING_PHOTOS p ON p.photo_id = a.photo_id
      WHERE p.category_id = @categoryId
        AND a.is_validated = 1
        AND (@since IS NULL OR a.created_at > @since)
    `);
  return r.recordset[0].n;
};

// Inserta una cajita (bbox) real contra una foto ya existente en RETSC_AI_TRAINING_PHOTOS.
// No tiene ningún llamador hoy en este repo — Etapa 7 de shelfPhotoUploadService ya no
// crea una anotación "placeholder" al subir la foto (ver ese archivo); las cajitas reales
// las crea el equipo de anotación (Issue #42, externo, todavía no integrado acá). Se deja
// lista con el esquema correcto para cuando ese flujo llegue.
const insert = async ({
  photo_id,
  bbox_left = null,
  bbox_top = null,
  bbox_width = null,
  bbox_height = null,
  source = 'ADMIN_UPLOAD',
  is_validated = 0,
}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId',     sql.Int,   photo_id)
    .input('left',        sql.Float, bbox_left)
    .input('top',         sql.Float, bbox_top)
    .input('width',       sql.Float, bbox_width)
    .input('height',      sql.Float, bbox_height)
    .input('source',      sql.VarChar(20), source)
    .input('isValidated', sql.Bit,   is_validated)
    .query(`
      INSERT INTO ${TABLE}
        (photo_id, bbox_left, bbox_top, bbox_width, bbox_height, source, is_validated, created_at)
      OUTPUT INSERTED.*
      VALUES
        (@photoId, @left, @top, @width, @height, @source, @isValidated, GETDATE())
    `);
  return r.recordset[0];
};

// Actualiza SOLO cv_region_id de una cajita (Issue 8.2). cv_sync_status/error/attempts
// se movieron a nivel de foto — ver trainingPhotoRepo.updateCvSync.
const updateCvRegionId = async (id, cvRegionId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',         sql.Int,          id)
    .input('cvRegionId', sql.VarChar(100), cvRegionId ?? null)
    .query(`
      UPDATE ${TABLE}
      SET    cv_region_id = @cvRegionId
      OUTPUT INSERTED.*
      WHERE  annotation_id = @id
    `);
  return r.recordset[0] ?? null;
};

module.exports = {
  findById,
  listByPhoto,
  approve,
  correct,
  validateAllByPhoto,
  remove,
  countByPhoto,
  countValidatedByPhoto,
  countNewValidatedPhotos,
  insert,
  updateCvRegionId,
};
