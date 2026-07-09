// RETSC_AI_TRAINING_ANNOTATIONS — anotaciones (bounding boxes) de fotos de góndola
// para el entrenamiento de Custom Vision.
//
// Esquema (confirmado en BD, Issue 7.2 verificado):
//   annotation_id (PK), photo_id, dtc_category_id,
//   bbox_left, bbox_top, bbox_width, bbox_height (float),
//   source (varchar(20)), is_validated (bit), created_at,
//   photo_approved (bit), photo_notes (varchar(250)), photo_reviewed_at, photo_reviewer_id,
//   cv_region_id (varchar(100)), canal (varchar(20) NOT NULL)
//
// NOTA: la columna `canal` ya existía en la BD al verificar con INFORMATION_SCHEMA (Issue 7.2).
// No fue necesaria migración 007.
//
// Acciones del Issue 7.5:
//   APROBAR  → is_validated = 1
//   CORREGIR → coordenadas + is_validated = 1
//   RECHAZAR → eliminar el registro
// Al aprobar/corregir se registra quién y cuándo (photo_reviewer_id, photo_reviewed_at).

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

// APROBAR: marca validada y registra revisor + fecha.
const approve = async (id, reviewerId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',       sql.Int, id)
    .input('reviewer', sql.Int, reviewerId ?? null)
    .query(`
      UPDATE ${TABLE}
      SET    is_validated = 1,
             photo_reviewer_id = @reviewer,
             photo_reviewed_at = GETDATE()
      OUTPUT INSERTED.*
      WHERE  annotation_id = @id
    `);
  return r.recordset[0] ?? null;
};

// CORREGIR: actualiza coordenadas, marca validada y registra revisor + fecha.
const correct = async (id, bbox, reviewerId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id',       sql.Int,   id)
    .input('left',     sql.Float, bbox.bbox_left)
    .input('top',      sql.Float, bbox.bbox_top)
    .input('width',    sql.Float, bbox.bbox_width)
    .input('height',   sql.Float, bbox.bbox_height)
    .input('reviewer', sql.Int,   reviewerId ?? null)
    .query(`
      UPDATE ${TABLE}
      SET    bbox_left   = @left,
             bbox_top    = @top,
             bbox_width  = @width,
             bbox_height = @height,
             is_validated = 1,
             photo_reviewer_id = @reviewer,
             photo_reviewed_at = GETDATE()
      OUTPUT INSERTED.*
      WHERE  annotation_id = @id
    `);
  return r.recordset[0] ?? null;
};

// APROBAR FOTO COMPLETA: marca todas las anotaciones de una foto como
// validadas y aprobadas en una sola operación. Retorna todas las anotaciones
// actualizadas. Usado cuando el revisor aprueba la foto entera desde el canvas.
const approvePhoto = async (photoId, reviewerId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId',  sql.Int, photoId)
    .input('reviewer', sql.Int, reviewerId ?? null)
    .query(`
      UPDATE ${TABLE}
      SET    is_validated      = 1,
             photo_approved    = 1,
             photo_reviewer_id = @reviewer,
             photo_reviewed_at = GETDATE()
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
// entrenamiento (Issue 8.5, regla "mínimo 20 fotos nuevas para re-entrenar").
// Cuenta fotos distintas (photo_id) con al menos 1 anotación validada cuyo created_at
// es posterior a sinceDate. Si sinceDate es null (modelo nunca entrenado), cuenta todas.
const countNewValidatedPhotos = async (categoryId, sinceDate) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int,      categoryId)
    .input('since',      sql.DateTime, sinceDate ?? null)
    .query(`
      SELECT COUNT(DISTINCT photo_id) AS n
      FROM ${TABLE}
      WHERE dtc_category_id = @categoryId
        AND is_validated = 1
        AND (@since IS NULL OR created_at > @since)
    `);
  return r.recordset[0].n;
};

// Inserta una anotación nueva al subir una foto de góndola (Issue 7.2).
// Las bboxes y cv_region_id se completan en Issue #42 (anotación por el equipo DTC).
// photo_notes guarda el resumen de trazabilidad: blobPath + hash + cvImageId.
//
// NOTA: canal es NOT NULL en la BD, siempre debe venir informado.
const insert = async ({
  photo_id,
  dtc_category_id,
  canal,
  source       = 'ADMIN_UPLOAD',
  is_validated = 0,
  photo_notes  = null,
}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId',       sql.Int,          photo_id)
    .input('categoryId',    sql.Int,          dtc_category_id)
    .input('canal',         sql.VarChar(20),  canal)
    .input('source',        sql.VarChar(20),  source)
    .input('isValidated',   sql.Bit,          is_validated)
    .input('photoNotes',    sql.VarChar(250), photo_notes ?? null)
    .query(`
      INSERT INTO ${TABLE}
        (photo_id, dtc_category_id, canal, source, is_validated,
         photo_approved, photo_notes, bbox_left, bbox_top, bbox_width, bbox_height,
         cv_region_id, created_at)
      OUTPUT INSERTED.*
      VALUES
        (@photoId, @categoryId, @canal, @source, @isValidated,
         NULL, @photoNotes, NULL, NULL, NULL, NULL,
         NULL, GETDATE())
    `);
  return r.recordset[0];
};

// Cuenta fotos distintas con anotación validada y aprobada por categoría y canal.
// Usado en la Etapa 8 del flujo de carga para detectar si se alcanzó el umbral
// de imágenes suficientes para marcar el modelo como IMAGES_UPLOADED.
const countValidatedApprovedByCategoryChannel = async (categoryId, canal) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int,         categoryId)
    .input('canal',      sql.VarChar(20), canal)
    .query(`
      SELECT COUNT(DISTINCT photo_id) AS n
      FROM ${TABLE}
      WHERE dtc_category_id = @categoryId
        AND canal           = @canal
        AND is_validated    = 1
        AND photo_approved  = 1
    `);
  return r.recordset[0].n;
};

module.exports = {
  findById,
  listByPhoto,
  approve,
  approvePhoto,
  correct,
  remove,
  countByPhoto,
  countValidatedByPhoto,
  countNewValidatedPhotos,
  insert,
  countValidatedApprovedByCategoryChannel,
};
