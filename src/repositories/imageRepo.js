const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_LOG_IMAGE_UPLOAD';

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE Image_id = @id`);
  return r.recordset[0] ?? null;
};

const findByHash = async (hash, enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('hash',         sql.VarChar(100), hash)
    .input('enterpriseId', sql.Int,          enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE Hash = @hash AND Enterprise_id = @enterpriseId`);
  return r.recordset[0] ?? null;
};

const findByProduct = async (productId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('productId', sql.Int, productId)
    .query(`SELECT * FROM ${TABLE} WHERE Product_id = @productId`);
  return r.recordset;
};

const insert = async (image) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('productId',    sql.Int,               image.Product_id)
    .input('enterpriseId', sql.Int,               image.Enterprise_id)
    .input('hash',         sql.VarChar(100),      image.Hash)
    .input('blobUrl',      sql.NVarChar(sql.MAX), image.Blob_url)
    .input('status',       sql.Int,               image.Status ?? 1)
    .input('createdDate',  sql.VarChar(50),       image.Created_date ?? new Date().toISOString())
    .query(`
      INSERT INTO ${TABLE} (Product_id, Enterprise_id, Hash, Blob_url, Status, Created_date)
      OUTPUT INSERTED.*
      VALUES (@productId, @enterpriseId, @hash, @blobUrl, @status, @createdDate)
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

module.exports = { findById, findByHash, findByProduct, insert, insertMany };
