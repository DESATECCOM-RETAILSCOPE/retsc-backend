// RETSC_EX_SHELFPHOTO — fotos de góndola (shelf photos).
//
// Esquema base (confirmado en BD):
//   Photo_id (PK), Retailer_id, Shelfunit_id, photo_date, URL_blob,
//   ENTERPRISE_ID, CATEGORY_ID, visit_id
//
// Columnas de calidad/dedup agregadas en migración 005 (Issue 7.1):
//   image_hash, quality_status, quality_error_code, width, height,
//   blur_score, brightness
//
// NOTA: se asume que Photo_id es IDENTITY (autoincremental), por eso insert() no lo
// envía. Si en la BD no fuera IDENTITY, habría que pasar Photo_id explícito.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_EX_SHELFPHOTO';

// Dedup por enterprise: ¿ya existe una foto con este hash para este enterprise?
// Devuelve la fila existente o null. Soporta el criterio DUPLICATE_IMAGE.
const findByHash = async (hash, enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('hash',         sql.VarChar(64), hash)
    .input('enterpriseId', sql.Int,         enterpriseId)
    .query(`
      SELECT TOP 1 *
      FROM ${TABLE}
      WHERE image_hash = @hash AND ENTERPRISE_ID = @enterpriseId
    `);
  return r.recordset[0] ?? null;
};

// Inserta una foto de góndola con su veredicto de calidad. Devuelve la fila creada.
const insert = async (photo) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('retailerId',   sql.Int,           photo.retailer_id ?? null)
    .input('shelfunitId',  sql.Int,           photo.shelfunit_id ?? null)
    .input('photoDate',    sql.Date,          photo.photo_date ?? null)
    .input('urlBlob',      sql.NVarChar(250), photo.url_blob ?? null)
    .input('enterpriseId', sql.Int,           photo.enterprise_id ?? null)
    .input('categoryId',   sql.Int,           photo.category_id ?? null)
    .input('visitId',      sql.Int,           photo.visit_id ?? null)
    .input('imageHash',    sql.VarChar(64),   photo.image_hash ?? null)
    .input('qualityStatus',sql.VarChar(20),   photo.quality_status ?? null)
    .input('qualityError', sql.VarChar(30),   photo.quality_error_code ?? null)
    .input('width',        sql.Int,           photo.width ?? null)
    .input('height',       sql.Int,           photo.height ?? null)
    .input('blurScore',    sql.Float,         photo.blur_score ?? null)
    .input('brightness',   sql.Float,         photo.brightness ?? null)
    .query(`
      INSERT INTO ${TABLE}
        (Retailer_id, Shelfunit_id, photo_date, URL_blob, ENTERPRISE_ID, CATEGORY_ID,
         visit_id, image_hash, quality_status, quality_error_code, width, height,
         blur_score, brightness)
      OUTPUT INSERTED.*
      VALUES
        (@retailerId, @shelfunitId, @photoDate, @urlBlob, @enterpriseId, @categoryId,
         @visitId, @imageHash, @qualityStatus, @qualityError, @width, @height,
         @blurScore, @brightness)
    `);
  return r.recordset[0];
};

// Dedup GLOBAL: ¿ya existe una foto con este hash sin importar el enterprise?
// Usado en el flujo de carga de góndola donde la foto es global (ENTERPRISE_ID = null).
const findByHashGlobal = async (hash) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('hash', sql.VarChar(64), hash)
    .query(`SELECT TOP 1 * FROM ${TABLE} WHERE image_hash = @hash AND ENTERPRISE_ID IS NULL`);
  return r.recordset[0] ?? null;
};

module.exports = { findByHash, findByHashGlobal, insert };
