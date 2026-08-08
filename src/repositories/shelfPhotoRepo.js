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
//
// Issue 7.2: se agrega findByHashGlobal para el dedup de fotos globales (sin enterprise).
// Las fotos globales tienen ENTERPRISE_ID=NULL; el dedup por enterprise de assessPhoto
// no aplica para este flujo.

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

// Dedup global (Issue 7.2): ¿ya existe una foto global (ENTERPRISE_ID IS NULL) con este hash?
// Devuelve la fila existente o null. Se usa en el flujo de carga de fotos de góndola globales
// para evitar duplicados en el dataset de entrenamiento sin acotar por enterprise.
const findByHashGlobal = async (hash) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('hash', sql.VarChar(64), hash)
    .query(`
      SELECT TOP 1 *
      FROM ${TABLE}
      WHERE image_hash = @hash AND ENTERPRISE_ID IS NULL
    `);
  return r.recordset[0] ?? null;
};

// Categorías distintas cubiertas por las fotos de una visita (guía "Fotos de Visita" v1.9,
// sección 1, callout Paso 0: "una visita puede cubrir varias categorías... bajo el mismo
// Visit_id"). Usado por visitResultsService (Paso 6) para saber contra cuántas categorías
// hay que calcular los faltantes de surtido (sección 8.2 — la consulta de assortmentRepo
// es por una sola categoría a la vez).
const listCategoryIdsByVisit = async (visitId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('visitId', sql.Int, visitId)
    .query(`
      SELECT DISTINCT CATEGORY_ID
      FROM ${TABLE}
      WHERE visit_id = @visitId AND CATEGORY_ID IS NOT NULL
    `);
  return r.recordset.map(row => row.CATEGORY_ID);
};

module.exports = { findByHash, findByHashGlobal, insert, listCategoryIdsByVisit };
