const { getPool, sql } = require('../config/db');

// RETSC_LOG_IMAGE_UPLOAD — esquema real (confirmado de bd_actual.json):
//   image_log_id (PK), enterprise_id, upload_batch_id, sku_id, ean,
//   image_name, image_url, image_hash, image_status, process_status (NOT NULL),
//   ocr_status, embeddings_status, error_code, error_message, created_at

const TABLE = 'RETSC_LOG_IMAGE_UPLOAD';

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE image_log_id = @id`);
  return r.recordset[0] ?? null;
};

const findByHash = async (hash, enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('hash',         sql.VarChar(200), hash)
    .input('enterpriseId', sql.Int,          enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE image_hash = @hash AND enterprise_id = @enterpriseId`);
  return r.recordset[0] ?? null;
};

// Busca imágenes por sku_id (el campo real en la tabla)
const findBySku = async (skuId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('skuId', sql.Int, skuId)
    .query(`SELECT * FROM ${TABLE} WHERE sku_id = @skuId`);
  return r.recordset;
};

// Alias de compatibilidad — la tabla no tiene Product_id, solo sku_id
const findByProduct = findBySku;

const insert = async (image) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId',  sql.Int,              image.enterprise_id)
    .input('batchId',       sql.UniqueIdentifier, image.upload_batch_id)
    .input('skuId',         sql.Int,              image.sku_id ?? null)
    .input('ean',           sql.VarChar(20),       image.ean ?? null)
    .input('imageName',     sql.VarChar(500),      image.image_name ?? null)
    .input('imageUrl',      sql.VarChar(1000),     image.image_url ?? null)
    .input('imageHash',     sql.VarChar(200),      image.image_hash ?? null)
    .input('imageStatus',   sql.VarChar(50),       image.image_status ?? null)
    .input('processStatus', sql.VarChar(50),       image.process_status ?? 'pending')
    .query(`
      INSERT INTO ${TABLE}
        (enterprise_id, upload_batch_id, sku_id, ean, image_name,
         image_url, image_hash, image_status, process_status, created_at)
      OUTPUT INSERTED.*
      VALUES
        (@enterpriseId, @batchId, @skuId, @ean, @imageName,
         @imageUrl, @imageHash, @imageStatus, @processStatus, GETDATE())
    `);
  return r.recordset[0];
};

const insertMany = async (images) => {
  const inserted = [];
  for (const img of images) {
    inserted.push(await insert(img));
  }
  return inserted;
};

module.exports = { findById, findByHash, findBySku, findByProduct, insert, insertMany };
