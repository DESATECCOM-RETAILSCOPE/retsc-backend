// Repositorio para RETSC_AI_SKU_FEATURES y RETSC_AI_SKU_IMAGE_METADATA.
//
// RETSC_AI_SKU_FEATURES — una fila por imagen por SKU:
//   feature_id         INT IDENTITY PK
//   sku_id             INT NOT NULL
//   image_url          VARCHAR(500)  NULL
//   image_hash         VARCHAR(100)  NULL  — SHA-256 hex (dedup)
//   ocr_text           NVARCHAR(MAX) NULL  — llenado por pipeline de OCR (no en esta pasada)
//   embedding_status   VARCHAR(20)   NULL
//   validation_status  VARCHAR(20)   NULL
//   confidence         FLOAT         NULL
//   processed_at       DATETIME      NULL  DEFAULT getdate()
//   feature_vector_id  VARCHAR(200)  NULL
//   ocr_language       VARCHAR(20)   NULL
//   created_at         DATETIME      NULL
//   is_primary         BIT           NOT NULL DEFAULT 0
//
// RETSC_AI_SKU_IMAGE_METADATA — metadata extendida en key-value:
//   image_metadata_id      BIGINT IDENTITY PK
//   feature_id             INT NOT NULL  → FK a RETSC_AI_SKU_FEATURES
//   metadata_key           NVARCHAR(100)
//   metadata_value         NVARCHAR(1000)
//   created_at             DATETIME DEFAULT getdate()
//   metadata_definition_id INT NULL  → FK a RETSC_AI_METADATA_DEFINITIONS
//
// TODO: cuando se pueble RETSC_AI_METADATA_DEFINITIONS con las keys oficiales
// (uploaded_by, original_filename, perspective, upload_date, file_size_kb),
// resolver los metadata_definition_id y pasarlos en insertMetadata().

const { getPool, sql } = require('../config/db');

const FEATURES_TABLE  = 'RETSC_AI_SKU_FEATURES';
const METADATA_TABLE  = 'RETSC_AI_SKU_IMAGE_METADATA';

// ─── Lectura ─────────────────────────────────────────────────────────────────

// Dedup: busca si ya existe una imagen con ese hash para ese SKU.
const findBySkuIdAndHash = async (skuId, hash) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('skuId', sql.Int,         skuId)
    .input('hash',  sql.VarChar(100), hash)
    .query(`SELECT TOP 1 * FROM ${FEATURES_TABLE} WHERE sku_id = @skuId AND image_hash = @hash`);
  return r.recordset[0] ?? null;
};

// Lista todas las imágenes de un SKU ordenadas: primaria primero.
const findBySkuId = async (skuId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('skuId', sql.Int, skuId)
    .query(`
      SELECT * FROM ${FEATURES_TABLE}
      WHERE sku_id = @skuId
      ORDER BY is_primary DESC, created_at ASC
    `);
  return r.recordset;
};

// Cuenta imágenes de un SKU (para determinar is_primary en el primer insert).
const countBySku = async (skuId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('skuId', sql.Int, skuId)
    .query(`SELECT COUNT(*) AS cnt FROM ${FEATURES_TABLE} WHERE sku_id = @skuId`);
  return r.recordset[0].cnt;
};

// ─── Escritura ────────────────────────────────────────────────────────────────

// Inserta un nuevo registro de imagen de SKU.
// isPrimary: pasar 1 solo si es la primera imagen del SKU (verificar con countBySku antes).
const insert = async ({ skuId, imageUrl, imageHash, isPrimary = 0 }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('skuId',     sql.Int,          skuId)
    .input('imageUrl',  sql.VarChar(500),  imageUrl)
    .input('imageHash', sql.VarChar(100),  imageHash)
    .input('isPrimary', sql.Bit,           isPrimary)
    .query(`
      INSERT INTO ${FEATURES_TABLE} (sku_id, image_url, image_hash, is_primary, created_at)
      OUTPUT INSERTED.*
      VALUES (@skuId, @imageUrl, @imageHash, @isPrimary, GETDATE())
    `);
  return r.recordset[0];
};

// Inserta filas de metadata extendida para un feature recién creado.
// entries: array de { key, value }
// NOTA: metadata_definition_id queda NULL hasta que se pueble RETSC_AI_METADATA_DEFINITIONS.
const insertMetadata = async (featureId, entries) => {
  if (!entries || entries.length === 0) return;
  const pool = await getPool();
  for (const { key, value } of entries) {
    await pool.request()
      .input('featureId', sql.Int,           featureId)
      .input('key',       sql.NVarChar(100),  key)
      .input('value',     sql.NVarChar(1000), value != null ? String(value) : null)
      .query(`
        INSERT INTO ${METADATA_TABLE} (feature_id, metadata_key, metadata_value)
        VALUES (@featureId, @key, @value)
      `);
  }
};

// Marca un feature como primario y desmarca todos los demás del mismo SKU.
// Usa transacción: son dos operaciones atómicas (el prompt lo requiere para setPrimary).
const setPrimary = async (featureId, skuId) => {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    await transaction.request()
      .input('skuId', sql.Int, skuId)
      .query(`UPDATE ${FEATURES_TABLE} SET is_primary = 0 WHERE sku_id = @skuId`);

    const r = await transaction.request()
      .input('id', sql.Int, featureId)
      .query(`
        UPDATE ${FEATURES_TABLE} SET is_primary = 1
        OUTPUT INSERTED.*
        WHERE feature_id = @id
      `);

    await transaction.commit();
    return r.recordset[0] ?? null;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

module.exports = {
  findBySkuIdAndHash,
  findBySkuId,
  countBySku,
  insert,
  insertMetadata,
  setPrimary,
};
