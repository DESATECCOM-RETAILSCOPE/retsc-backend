const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_LOG_SKU_UPLOAD';

function parseJson(val) {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return null; }
}

function toRow(r) {
  if (!r) return null;
  return {
    ...r,
    Excel_data:  parseJson(r.Excel_data),
    Image_files: parseJson(r.Image_files),
    Metrics:     parseJson(r.Metrics),
  };
}

const findById = async (jobId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('jobId', sql.VarChar(50), jobId)
    .query(`SELECT * FROM ${TABLE} WHERE Job_id = @jobId`);
  return toRow(r.recordset[0] ?? null);
};

const insert = async (loadState) => {
  if (!loadState.Job_id) throw new Error('loadState must include a Job_id (UUID)');
  const pool = await getPool();
  const r = await pool.request()
    .input('jobId',        sql.VarChar(50),        loadState.Job_id)
    .input('enterpriseId', sql.Int,                loadState.Enterprise_id)
    .input('status',       sql.VarChar(50),        loadState.Status ?? 'pending')
    .input('currentStep',  sql.VarChar(50),        loadState.Current_step ?? null)
    .input('createdDate',  sql.VarChar(50),        loadState.Created_date ?? new Date().toISOString())
    .input('updatedDate',  sql.VarChar(50),        loadState.Updated_date ?? new Date().toISOString())
    .input('excelData',    sql.NVarChar(sql.MAX),  JSON.stringify(loadState.Excel_data ?? null))
    .input('imageFiles',   sql.NVarChar(sql.MAX),  JSON.stringify(loadState.Image_files ?? null))
    .input('metrics',      sql.NVarChar(sql.MAX),  JSON.stringify(loadState.Metrics ?? null))
    .input('errorMessage', sql.NVarChar(sql.MAX),  loadState.Error_message ?? null)
    .query(`
      INSERT INTO ${TABLE}
        (Job_id, Enterprise_id, Status, Current_step, Created_date, Updated_date,
         Excel_data, Image_files, Metrics, Error_message)
      OUTPUT INSERTED.*
      VALUES
        (@jobId, @enterpriseId, @status, @currentStep, @createdDate, @updatedDate,
         @excelData, @imageFiles, @metrics, @errorMessage)
    `);
  return toRow(r.recordset[0]);
};

const update = async (jobId, partial) => {
  const pool = await getPool();
  const req = pool.request().input('jobId', sql.VarChar(50), jobId);
  const set = [];

  if (partial.Status !== undefined)        { req.input('status',      sql.VarChar(50),       partial.Status);                         set.push('Status = @status'); }
  if (partial.Current_step !== undefined)  { req.input('step',        sql.VarChar(50),       partial.Current_step);                   set.push('Current_step = @step'); }
  if (partial.Updated_date !== undefined)  { req.input('updatedDate', sql.VarChar(50),       partial.Updated_date);                   set.push('Updated_date = @updatedDate'); }
  if (partial.Error_message !== undefined) { req.input('errMsg',      sql.NVarChar(sql.MAX), partial.Error_message);                  set.push('Error_message = @errMsg'); }
  if (partial.Excel_data !== undefined)    { req.input('excelData',   sql.NVarChar(sql.MAX), JSON.stringify(partial.Excel_data));     set.push('Excel_data = @excelData'); }
  if (partial.Image_files !== undefined)   { req.input('imageFiles',  sql.NVarChar(sql.MAX), JSON.stringify(partial.Image_files));    set.push('Image_files = @imageFiles'); }
  if (partial.Metrics !== undefined)       { req.input('metrics',     sql.NVarChar(sql.MAX), JSON.stringify(partial.Metrics));        set.push('Metrics = @metrics'); }

  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE ${TABLE} SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE Job_id = @jobId
  `);
  return toRow(r.recordset[0] ?? null);
};

const listByEnterprise = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE Enterprise_id = @enterpriseId`);
  return r.recordset.map(toRow);
};

module.exports = { findById, insert, update, listByEnterprise };
