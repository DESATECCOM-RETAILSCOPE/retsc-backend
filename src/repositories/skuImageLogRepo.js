// Repositorio para RETSC_LOG_IMAGE_UPLOAD.
// Registra cada intento de carga de imagen: exitoso, huérfano, duplicado o error.
//
// ESQUEMA:
//   image_log_id      INT IDENTITY PK
//   enterprise_id     INT NOT NULL
//   upload_batch_id   UNIQUEIDENTIFIER NOT NULL  — agrupa todos los archivos de un mismo request
//   sku_id            INT NULL
//   ean               VARCHAR(20)  NULL
//   image_name        VARCHAR(500) NULL           — nombre original del archivo
//   image_url         VARCHAR(1000) NULL          — URL en Blob (null si no se subió)
//   image_hash        VARCHAR(200) NULL
//   image_status      VARCHAR(50)  NULL
//   process_status    VARCHAR(50)  NOT NULL
//   ocr_status        VARCHAR(50)  NULL           — llenado por pipeline de OCR
//   embeddings_status VARCHAR(50)  NULL           — llenado por pipeline de embeddings
//   error_code        VARCHAR(100) NULL
//   error_message     VARCHAR(1000) NULL
//   created_at        DATETIME NULL DEFAULT getdate()
//
// Valores de process_status usados en esta pasada:
//   'COMPLETED'  — imagen subida e insertada en RETSC_AI_SKU_FEATURES correctamente
//   'ORPHAN'     — EAN no existe aún; blob subido a huerfanas/, sin registro en SKU_FEATURES
//   'ADOPTED'    — huérfana adoptada retroactivamente; registro creado en SKU_FEATURES
//   'DUPLICATE'  — hash ya existe para ese SKU (no se sube blob)
//   'ERROR'      — error inesperado

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_LOG_IMAGE_UPLOAD';

// ─── Escritura ────────────────────────────────────────────────────────────────

const insertLog = async ({
  enterpriseId,
  uploadBatchId,
  skuId         = null,
  ean           = null,
  imageName     = null,
  imageUrl      = null,
  imageHash     = null,
  imageStatus   = null,
  processStatus,
  errorCode     = null,
  errorMessage  = null,
}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId',  sql.Int,              enterpriseId)
    .input('uploadBatchId', sql.UniqueIdentifier,  uploadBatchId)
    .input('skuId',         sql.Int,               skuId ?? null)
    .input('ean',           sql.VarChar(20),        ean ?? null)
    .input('imageName',     sql.VarChar(500),       imageName ?? null)
    .input('imageUrl',      sql.VarChar(1000),      imageUrl ?? null)
    .input('imageHash',     sql.VarChar(200),       imageHash ?? null)
    .input('imageStatus',   sql.VarChar(50),        imageStatus ?? null)
    .input('processStatus', sql.VarChar(50),        processStatus)
    .input('errorCode',     sql.VarChar(100),       errorCode ?? null)
    .input('errorMessage',  sql.VarChar(1000),      errorMessage ?? null)
    .query(`
      INSERT INTO ${TABLE}
        (enterprise_id, upload_batch_id, sku_id, ean, image_name, image_url, image_hash,
         image_status, process_status, error_code, error_message)
      OUTPUT INSERTED.image_log_id
      VALUES
        (@enterpriseId, @uploadBatchId, @skuId, @ean, @imageName, @imageUrl, @imageHash,
         @imageStatus, @processStatus, @errorCode, @errorMessage)
    `);
  return r.recordset[0]?.image_log_id ?? null;
};

// Registra el resultado de una validación de calidad de imagen (Issue 6.1).
// process_status = 'QUALITY_CHECK'
// image_status   = resultado: 'VALID' | 'LOW_RESOLUTION' | 'BLURRY' | 'POOR_LIGHTING'
// error_message  = lista de todos los fallos (puede haber más de uno) o null si VALID.
// NOTA: upload_batch_id es NOT NULL → se usa un UUID fijo de sistema para estas filas.
const insertValidationLog = async ({
  enterpriseId,
  skuId,
  featureId,
  imageUrl,
  validationStatus,
  failures,
}) => {
  const VALIDATION_BATCH = '00000000-0000-0000-0000-000000000001';
  const errorMessage = failures && failures.length > 0 ? failures.join(', ') : null;

  return insertLog({
    enterpriseId,
    uploadBatchId: VALIDATION_BATCH,
    skuId:         skuId ?? null,
    imageUrl:      imageUrl ?? null,
    imageStatus:   validationStatus,
    processStatus: 'QUALITY_CHECK',
    errorCode:     validationStatus !== 'VALID' ? validationStatus : null,
    errorMessage,
  });
};

// Actualiza sku_id, process_status e image_status de un log al adoptar una huérfana.
const markAdopted = async (imageLogId, skuId) => {
  const pool = await getPool();
  await pool.request()
    .input('id',           sql.Int,        imageLogId)
    .input('skuId',        sql.Int,        skuId)
    .input('processStatus', sql.VarChar(50), 'ADOPTED')
    .input('imageStatus',   sql.VarChar(50), 'ADOPTED')
    .query(`
      UPDATE ${TABLE}
      SET process_status = @processStatus,
          image_status   = @imageStatus,
          sku_id         = @skuId
      WHERE image_log_id = @id
    `);
};

// ─── Lectura ──────────────────────────────────────────────────────────────────

// Busca huérfanas pendientes de adopción para un EAN específico.
// Una huérfana pendiente tiene process_status='ORPHAN' e image_url en blob (no null).
const findOrphansByEan = async (ean) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('ean', sql.VarChar(20), ean)
    .query(`
      SELECT * FROM ${TABLE}
      WHERE ean = @ean
        AND process_status = 'ORPHAN'
        AND image_url IS NOT NULL
      ORDER BY created_at ASC
    `);
  return r.recordset;
};

module.exports = { insertLog, insertValidationLog, markAdopted, findOrphansByEan };
