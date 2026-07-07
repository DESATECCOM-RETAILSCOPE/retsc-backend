// RETSC_AI_TRAINING_ANNOTATIONS — anotaciones (bounding boxes) de fotos de góndola
// para el entrenamiento de Custom Vision.
//
// Esquema (confirmado en BD):
//   annotation_id (PK), photo_id, dtc_category_id,
//   bbox_left, bbox_top, bbox_width, bbox_height (float),
//   source (varchar), is_validated (bit), created_at,
//   photo_approved (bit), photo_notes, photo_reviewed_at, photo_reviewer_id, cv_region_id
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

// Inserta una anotación pendiente de revisión. Los bbox_* pueden ser null (sin coordenadas
// aún). canal es obligatorio para el flujo de góndola (OMT/DTT/CONVENIENCE).
const insert = async (annotation) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId',    sql.Int,         annotation.photo_id)
    .input('categoryId', sql.Int,         annotation.dtc_category_id)
    .input('bboxLeft',   sql.Float,       annotation.bbox_left   ?? null)
    .input('bboxTop',    sql.Float,       annotation.bbox_top    ?? null)
    .input('bboxWidth',  sql.Float,       annotation.bbox_width  ?? null)
    .input('bboxHeight', sql.Float,       annotation.bbox_height ?? null)
    .input('source',     sql.VarChar(50), annotation.source      ?? 'upload')
    .input('isValidated',sql.Bit,         annotation.is_validated ?? 0)
    .input('canal',      sql.VarChar(20), annotation.canal       ?? null)
    .query(`
      INSERT INTO ${TABLE}
        (photo_id, dtc_category_id, bbox_left, bbox_top, bbox_width, bbox_height,
         source, is_validated, canal)
      OUTPUT INSERTED.*
      VALUES
        (@photoId, @categoryId, @bboxLeft, @bboxTop, @bboxWidth, @bboxHeight,
         @source, @isValidated, @canal)
    `);
  return r.recordset[0];
};

// Cuenta fotos con al menos una anotación validada para un category+canal dado.
// Usado para el umbral de entrenamiento de Custom Vision (SHELF_TRAINING_THRESHOLD).
const countValidatedApprovedByCategoryChannel = async (categoryId, canal) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int,         categoryId)
    .input('canal',      sql.VarChar(20), canal)
    .query(`
      SELECT COUNT(DISTINCT a.photo_id) AS n
      FROM   ${TABLE} a
      JOIN   RETSC_EX_SHELFPHOTO p ON p.Photo_id = a.photo_id
      WHERE  a.dtc_category_id = @categoryId
        AND  a.canal           = @canal
        AND  a.is_validated    = 1
        AND  p.quality_status  = 'PASSED'
    `);
  return r.recordset[0].n;
};

module.exports = {
  findById,
  listByPhoto,
  approve,
  correct,
  remove,
  countByPhoto,
  countValidatedByPhoto,
  countNewValidatedPhotos,
  insert,
  countValidatedApprovedByCategoryChannel,
};
