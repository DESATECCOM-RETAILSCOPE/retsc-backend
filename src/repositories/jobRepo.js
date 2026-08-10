// Repositorio para la tabla RETSC_LOG_JOBS.
// Tracking del ciclo de vida de jobs asíncronos (upload de imágenes SKU, futuros batch jobs).
//
// STATUS:
//   QUEUED    — job creado, esperando procesamiento
//   RUNNING   — procesamiento en curso
//   COMPLETED — terminó sin errores fatales (puede tener error_count > 0)
//   FAILED    — error fatal que abortó el job

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_LOG_JOBS';

function toDTO(row) {
  return {
    ...row,
    // loadNumber solo viene poblado en filas de listByUser (ROW_NUMBER() calculado ahí,
    // Issue B5) — null en cualquier otra query de este repo que no lo seleccione.
    loadNumber: row.load_number ?? null,
    errorSummary: row.error_summary ? (() => {
      try { return JSON.parse(row.error_summary); } catch { return row.error_summary; }
    })() : null,
  };
}

// Crea un job en estado QUEUED. Devuelve el registro con job_id.
const create = async ({ userId, enterpriseId, jobType, totalFiles }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId',       sql.Int,        userId)
    .input('enterpriseId', sql.Int,        enterpriseId ?? null)
    .input('jobType',      sql.VarChar(50), jobType)
    .input('totalFiles',   sql.Int,        totalFiles)
    .query(`
      INSERT INTO ${TABLE} (user_id, enterprise_id, job_type, status, total_files)
      OUTPUT INSERTED.*
      VALUES (@userId, @enterpriseId, @jobType, 'QUEUED', @totalFiles)
    `);
  return toDTO(r.recordset[0]);
};

// Marca el job como RUNNING y registra el momento de inicio.
const markRunning = async (jobId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('jobId', sql.Int, jobId)
    .query(`
      UPDATE ${TABLE}
      SET status = 'RUNNING', started_at = GETDATE()
      OUTPUT INSERTED.*
      WHERE job_id = @jobId
    `);
  return r.recordset[0] ? toDTO(r.recordset[0]) : null;
};

// Actualiza contadores de progreso mientras el job está RUNNING.
// Llamar periódicamente desde el procesador para que el polling vea progreso real.
const updateProgress = async (jobId, { processed, orphans, duplicates, errors, warnings }) => {
  const pool = await getPool();
  await pool.request()
    .input('jobId',      sql.Int, jobId)
    .input('processed',  sql.Int, processed  ?? 0)
    .input('orphans',    sql.Int, orphans     ?? 0)
    .input('duplicates', sql.Int, duplicates  ?? 0)
    .input('errors',     sql.Int, errors      ?? 0)
    .input('warnings',   sql.Int, warnings    ?? 0)
    .query(`
      UPDATE ${TABLE}
      SET processed_count = @processed,
          orphan_count    = @orphans,
          duplicate_count = @duplicates,
          error_count     = @errors,
          warning_count   = @warnings
      WHERE job_id = @jobId
    `);
};

// Marca el job como COMPLETED con los contadores finales.
// summary viene de processBatch: { processed, orphans, duplicates, errors[], warnings }
const markCompleted = async (jobId, summary) => {
  const pool = await getPool();
  const errorSummary = summary.errors && summary.errors.length > 0
    ? JSON.stringify(summary.errors)
    : null;
  const warningCount = summary.warnings
    ? Object.values(summary.warnings).reduce((a, b) => a + b, 0)
    : 0;
  await pool.request()
    .input('jobId',      sql.Int,          jobId)
    .input('processed',  sql.Int,          summary.processed  ?? 0)
    .input('orphans',    sql.Int,          summary.orphans    ?? 0)
    .input('duplicates', sql.Int,          summary.duplicates ?? 0)
    .input('errors',     sql.Int,          summary.errors?.length ?? 0)
    .input('warnings',   sql.Int,          warningCount)
    .input('errSum',     sql.NVarChar(sql.MAX), errorSummary)
    .query(`
      UPDATE ${TABLE}
      SET status          = 'COMPLETED',
          finished_at     = GETDATE(),
          processed_count = @processed,
          orphan_count    = @orphans,
          duplicate_count = @duplicates,
          error_count     = @errors,
          warning_count   = @warnings,
          error_summary   = @errSum
      WHERE job_id = @jobId
    `);
};

// Marca el job como FAILED con el motivo serializado.
const markFailed = async (jobId, errorSummary) => {
  const pool = await getPool();
  await pool.request()
    .input('jobId',  sql.Int,               jobId)
    .input('errSum', sql.NVarChar(sql.MAX),  JSON.stringify(errorSummary))
    .query(`
      UPDATE ${TABLE}
      SET status      = 'FAILED',
          finished_at = GETDATE(),
          error_summary = @errSum
      WHERE job_id = @jobId
    `);
};

// Devuelve un job por ID, o null si no existe.
const findById = async (jobId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('jobId', sql.Int, jobId)
    .query(`SELECT * FROM ${TABLE} WHERE job_id = @jobId`);
  return r.recordset[0] ? toDTO(r.recordset[0]) : null;
};

// Lista jobs de un usuario ordenados del más reciente al más viejo.
//
// load_number (Issue B5, F5 frontend "Carga #N"): antes el frontend mostraba
// "Carga #{job_id}", la PK global de RETSC_LOG_JOBS — salta de números entre empresas y
// no arranca en 1 para cada una. Se calcula con ROW_NUMBER() PARTITION BY enterprise_id
// ORDER BY created_at ASC (subquery aparte para no interferir con el ORDER BY DESC +
// paginación de afuera, que sigue siendo "más reciente primero" — el número asignado a
// cada job no cambia entre páginas ni se recalcula al pedir la siguiente).
//
// NOTA — gap conocido, no cerrado en este fix: esta query ya filtra por user_id (este
// endpoint es "MIS cargas", no "cargas de mi empresa"), así que el PARTITION BY
// enterprise_id en la práctica numera solo los jobs DE ESTE usuario — si dos usuarios
// distintos de la MISMA empresa suben cargas, cada uno vería su propio contador arrancar
// en 1 en vez de compartir una sola secuencia por empresa. Hoy no existe un endpoint que
// liste jobs por empresa (solo por usuario) para probar/cerrar ese caso correctamente.
const listByUser = async (userId, { limit = 20, offset = 0 } = {}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('limit',  sql.Int, limit)
    .input('offset', sql.Int, offset)
    .query(`
      SELECT * FROM (
        SELECT *, CAST(ROW_NUMBER() OVER (PARTITION BY enterprise_id ORDER BY created_at ASC) AS INT) AS load_number
        FROM ${TABLE}
        WHERE user_id = @userId
      ) numbered
      ORDER BY created_at DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);
  return r.recordset.map(toDTO);
};

// Marca como FAILED todos los jobs que quedaron en RUNNING (recovery al startup).
// Devuelve la cantidad de filas afectadas.
const failStaleRunning = async (reason) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('reason', sql.NVarChar(sql.MAX), JSON.stringify({ message: reason }))
    .query(`
      UPDATE ${TABLE}
      SET status        = 'FAILED',
          finished_at   = GETDATE(),
          error_summary = @reason
      WHERE status = 'RUNNING'
    `);
  return r.rowsAffected[0];
};

module.exports = { create, markRunning, updateProgress, markCompleted, markFailed, findById, listByUser, failStaleRunning };
