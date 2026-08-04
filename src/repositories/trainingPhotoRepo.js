// RETSC_AI_TRAINING_PHOTOS — una fila por foto de góndola subida para entrenamiento.
//
// Migración de esquema del equipo DBA (detectada 2026-07-26 al ver "Invalid column name
// 'photo_approved'" en la review queue): los campos a nivel de FOTO que antes vivían en
// RETSC_AI_TRAINING_ANNOTATIONS (photo_notes, canal, dtc_category_id/category_id,
// blob_path, el estado de aprobación, cv_sync_status/error/attempts) se movieron a esta
// tabla nueva. RETSC_AI_TRAINING_ANNOTATIONS ahora solo tiene las cajitas (bboxes),
// enlazadas por photo_id (FK real: FK_ANNOTATION_PHOTO → RETSC_AI_TRAINING_PHOTOS.photo_id,
// verificado con sys.foreign_keys — NO apunta a RETSC_EX_SHELFPHOTO).
//
// Distinta de RETSC_EX_SHELFPHOTO: esa tabla sigue existiendo por separado (columnas de
// hash/calidad para el dedup de Etapa 4 de shelfPhotoUploadService.js) y NO tiene FK hacia
// esta — son dos IDs (Photo_id vs photo_id) en namespaces distintos. shelfPhotoUploadService
// sigue insertando en RETSC_EX_SHELFPHOTO para el dedup por hash; el photo_id que de verdad
// importa para el pipeline de anotación/review es el de ESTA tabla.
//
// Esquema real (verificado con INFORMATION_SCHEMA + sys.check_constraints, 2026-07-26):
//   photo_id (PK identity), uploaded_by_user_id, uploaded_by_enterprise_id (nullable —
//   NULL para fotos globales sin empresa), category_id, canal (CHECK: OMT|DTT|CONVENIENCE),
//   blob_path, photo_status (CHECK: EN_PROGRESO|LISTA_PARA_REVISION|APROBADA|RECHAZADA),
//   reviewer_id, reviewed_at, photo_notes, cv_sync_status, cv_sync_error, cv_sync_attempts,
//   created_at.
//
// TEMPORAL: cvImageId sigue viajando embebido en photo_notes (mismo formato de siempre,
// "blob:... | sha256:... | cvImageId:..."), ahora en esta tabla en vez de en la fila de
// anotación — no tiene columna propia todavía (ver annotationSyncService.js).

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_AI_TRAINING_PHOTOS';

// photo_status de la BD (español, CHECK constraint real) — se exponen hacia afuera con los
// mismos nombres en inglés que ya usaba el contrato de la API (listPhotos status=) para no
// romper al frontend, que ya consume PENDING_ANNOTATION/PENDING_REVIEW/APPROVED/REJECTED.
const STATUS_DB_BY_API = {
  PENDING_ANNOTATION: 'EN_PROGRESO',
  PENDING_REVIEW:     'LISTA_PARA_REVISION',
  APPROVED:           'APROBADA',
  REJECTED:           'RECHAZADA',
};

const findById = async (photoId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, photoId)
    .query(`SELECT * FROM ${TABLE} WHERE photo_id = @id`);
  return r.recordset[0] ?? null;
};

// Dedup POR CANAL (Issue B4) — ¿ya existe una foto de entrenamiento con este hash PARA
// ESTE canal específico? Esta tabla no tiene columna image_hash propia; el hash sigue
// viajando embebido en photo_notes (mismo TEMPORAL de siempre, "sha256:<hash>"). El hash
// SHA-256 es siempre hex ([0-9a-f]{64}) — sin caracteres comodín de LIKE — así que
// embeberlo en el patrón vía parámetro es seguro (mismo criterio que el resto del repo:
// nunca se concatena input de usuario en el SQL, solo se arma el patrón del LIKE).
const findByHashAndCanal = async (hash, canal) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('canal',   sql.VarChar(20),  canal)
    .input('pattern', sql.VarChar(100), `%sha256:${hash}%`)
    .query(`
      SELECT TOP 1 * FROM ${TABLE}
      WHERE canal = @canal AND photo_notes LIKE @pattern
    `);
  return r.recordset[0] ?? null;
};

// Inserta la foto recién subida. Estado inicial 'EN_PROGRESO' (sin cajitas todavía —
// Issue #42, equipo de anotación, todavía no vive en este repo).
const insert = async ({
  uploaded_by_user_id,
  uploaded_by_enterprise_id = null,
  category_id,
  canal,
  blob_path,
  photo_notes = null,
  photo_status = 'EN_PROGRESO',
}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('uploadedBy',      sql.Int,          uploaded_by_user_id)
    .input('enterpriseId',    sql.Int,          uploaded_by_enterprise_id)
    .input('categoryId',      sql.Int,          category_id)
    .input('canal',           sql.VarChar(20),  canal)
    .input('blobPath',        sql.VarChar(300), blob_path)
    .input('photoNotes',      sql.VarChar(250), photo_notes)
    .input('photoStatus',     sql.VarChar(30),  photo_status)
    .query(`
      INSERT INTO ${TABLE}
        (uploaded_by_user_id, uploaded_by_enterprise_id, category_id, canal, blob_path,
         photo_notes, photo_status, cv_sync_status, cv_sync_attempts, created_at)
      OUTPUT INSERTED.*
      VALUES
        (@uploadedBy, @enterpriseId, @categoryId, @canal, @blobPath,
         @photoNotes, @photoStatus, 'PENDING', 0, GETDATE())
    `);
  return r.recordset[0];
};

// Review queue — GET /api/annotations/photos. Antes vivía en annotationRepo.listPhotos
// agrupando RETSC_AI_TRAINING_ANNOTATIONS por photo_id (porque los campos de foto estaban
// duplicados en cada fila de anotación); ahora la foto es una sola fila nativa y solo hace
// falta un LEFT JOIN para contar cajitas. Mismo contrato de salida que antes
// (dtc_category_id/photo_approved como alias, para no romper al frontend).
const listPhotos = async ({ categoryId, canal, status } = {}) => {
  const pool = await getPool();
  const req = pool.request();

  let whereExtra = '';

  if (categoryId != null) {
    req.input('categoryId', sql.Int, categoryId);
    whereExtra += ' AND p.category_id = @categoryId';
  }
  if (canal) {
    req.input('canalFilter', sql.VarChar(20), canal);
    whereExtra += ' AND p.canal = @canalFilter';
  }
  if (status && STATUS_DB_BY_API[status]) {
    req.input('statusFilter', sql.VarChar(30), STATUS_DB_BY_API[status]);
    whereExtra += ' AND p.photo_status = @statusFilter';
  }

  const r = await req.query(`
    SELECT
      p.photo_id,
      p.blob_path,
      p.canal,
      p.category_id                                      AS dtc_category_id,
      COUNT(a.annotation_id)                              AS regionCount,
      ISNULL(MAX(CAST(a.is_validated AS INT)), 0)         AS is_validated,
      CASE WHEN p.photo_status = 'APROBADA' THEN 1 ELSE 0 END AS photo_approved,
      p.created_at
    FROM ${TABLE} p
    LEFT JOIN RETSC_AI_TRAINING_ANNOTATIONS a ON a.photo_id = p.photo_id
    WHERE 1=1
    ${whereExtra}
    GROUP BY p.photo_id, p.blob_path, p.canal, p.category_id, p.photo_status, p.created_at
    ORDER BY p.created_at DESC
  `);
  return r.recordset;
};

// Detalle de una foto + todas sus cajitas — GET /api/annotations/photos/:photoId.
// Dos queries en vez de un JOIN: los campos de foto ya no se repiten por cajita (antes el
// JOIN implícito de una sola tabla forzaba a tomar MAX/MIN de columnas duplicadas).
const getPhotoWithRegions = async (photoId) => {
  const photo = await findById(photoId);
  if (!photo) return null;

  const pool = await getPool();
  const r = await pool.request()
    .input('photoId', sql.Int, photoId)
    .query(`
      SELECT annotation_id, bbox_left, bbox_top, bbox_width, bbox_height, cv_region_id, is_validated
      FROM RETSC_AI_TRAINING_ANNOTATIONS
      WHERE photo_id = @photoId
      ORDER BY annotation_id
    `);

  return {
    photo_id:        photo.photo_id,
    blob_path:       photo.blob_path,
    canal:           photo.canal,
    dtc_category_id: photo.category_id,
    regions: r.recordset.map(row => ({
      annotation_id: row.annotation_id,
      bbox_left:     row.bbox_left,
      bbox_top:      row.bbox_top,
      bbox_width:    row.bbox_width,
      bbox_height:   row.bbox_height,
      cv_region_id:  row.cv_region_id,
      is_validated:  row.is_validated,
    })),
  };
};

// Aprobar la foto completa: el estado de aprobación vive acá ahora (antes era
// photo_approved=1 en cada fila de anotación). Validar las cajitas (is_validated=1) sigue
// siendo responsabilidad de annotationRepo — ver annotationRepo.validateAllByPhoto.
const approvePhoto = async (photoId, reviewerId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId',  sql.Int, photoId)
    .input('reviewer', sql.Int, reviewerId ?? null)
    .query(`
      UPDATE ${TABLE}
      SET    photo_status = 'APROBADA',
             reviewer_id  = @reviewer,
             reviewed_at  = GETDATE()
      OUTPUT INSERTED.*
      WHERE  photo_id = @photoId
    `);
  return r.recordset[0] ?? null;
};

// Cuenta fotos APROBADAS por categoría/canal (Etapa 8 de shelfPhotoUploadService +
// annotationSyncService.checkAndUpdateThreshold). Antes vivía en annotationRepo contando
// DISTINCT photo_id con is_validated=1 AND photo_approved=1 sobre las anotaciones; ahora
// categoría/canal/estado son nativos de esta tabla, no hace falta tocar anotaciones.
const countValidatedApprovedByCategoryChannel = async (categoryId, canal) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int,         categoryId)
    .input('canal',      sql.VarChar(20), canal)
    .query(`
      SELECT COUNT(*) AS n
      FROM ${TABLE}
      WHERE category_id = @categoryId AND canal = @canal AND photo_status = 'APROBADA'
    `);
  return r.recordset[0].n;
};

// Cuenta fotos SINCRONIZADAS (cv_sync_status='SYNCED') por categoría/canal, opcionalmente
// solo las más nuevas que `sinceDate` — cableado del disparo automático de training (spec
// v1.4, 4.3): "15 fotos, o +15 acumuladas desde el último entrenamiento". `sinceDate` es
// `model.trained_at`; si es null (categoría nunca entrenada), cuenta todas las SYNCED.
//
// NOTA: no hay una columna `synced_at` dedicada (solo `cv_sync_status`, sin timestamp propio
// del momento del sync) — se usa `created_at` (fecha de subida de la foto) como proxy. En la
// práctica el sync ocurre en la misma cadena de llamadas que la aprobación (segundos después
// de la subida), así que la diferencia es despreciable para un umbral de "15 fotos"; documentado
// acá por si algún día se agrega un timestamp de sync real y hay que migrar este conteo.
const countSyncedSinceByCategoryChannel = async (categoryId, canal, sinceDate) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('categoryId', sql.Int,      categoryId)
    .input('canal',      sql.VarChar(20), canal)
    .input('since',      sql.DateTime, sinceDate ?? null)
    .query(`
      SELECT COUNT(*) AS n
      FROM ${TABLE}
      WHERE category_id = @categoryId AND canal = @canal AND cv_sync_status = 'SYNCED'
        AND (@since IS NULL OR created_at > @since)
    `);
  return r.recordset[0].n;
};

// Actualiza el estado de sincronización con Custom Vision A NIVEL DE FOTO (Issue 8.2).
// Antes vivía en annotationRepo.updateCvSync operando por annotation_id — cv_sync_status/
// error/attempts se movieron acá; cv_region_id (por cajita) sigue en annotationRepo.
const updateCvSync = async (photoId, { syncStatus, syncError = null } = {}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('photoId',    sql.Int,          photoId)
    .input('syncStatus', sql.VarChar(20),  syncStatus)
    .input('syncError',  sql.VarChar(500), syncError ? String(syncError).slice(0, 500) : null)
    .query(`
      UPDATE ${TABLE}
      SET    cv_sync_status   = @syncStatus,
             cv_sync_error    = @syncError,
             cv_sync_attempts = ISNULL(cv_sync_attempts, 0) + 1
      OUTPUT INSERTED.*
      WHERE  photo_id = @photoId
    `);
  return r.recordset[0] ?? null;
};

module.exports = {
  findById,
  findByHashAndCanal,
  insert,
  listPhotos,
  countSyncedSinceByCategoryChannel,
  getPhotoWithRegions,
  approvePhoto,
  countValidatedApprovedByCategoryChannel,
  updateCvSync,
};
