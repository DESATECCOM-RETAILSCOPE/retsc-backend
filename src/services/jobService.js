// Servicio de jobs asíncronos.
// Encola y procesa uploads de imágenes SKU en background via setImmediate.
// El endpoint devuelve 202 inmediatamente; los clientes pollan GET /jobs/:jobId.

const jobRepo         = require('../repositories/jobRepo');
const skuImageService = require('./skuImageService');

function svcError(msg, statusCode) {
  const e = new Error(msg);
  e.statusCode = statusCode;
  return e;
}

// ─── Procesamiento background ─────────────────────────────────────────────────

async function processJob(jobId, files, uploadedBy, enterpriseId) {
  try {
    await jobRepo.markRunning(jobId);

    const result = await skuImageService.processBatch({
      files,
      uploadedBy,
      enterpriseId,
      onProgress: async (counts) => {
        await jobRepo.updateProgress(jobId, counts);
      },
    });

    await jobRepo.markCompleted(jobId, result);
    console.log(`[job ${jobId}] COMPLETED processed=${result.processed} orphans=${result.orphans} duplicates=${result.duplicates} errors=${result.errors.length}`);
  } catch (err) {
    console.error(`[job ${jobId}] FAILED:`, err.message);
    try {
      await jobRepo.markFailed(jobId, { message: err.message });
    } catch (e) {
      console.error('[job] no se pudo marcar FAILED:', e.message);
    }
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

// Encola un batch de imágenes y devuelve { jobId, status, totalFiles } inmediatamente.
// El procesamiento ocurre en background via setImmediate.
const enqueueSkuImageUpload = async ({ files, uploadedBy, enterpriseId }) => {
  const job = await jobRepo.create({
    userId:     uploadedBy,
    enterpriseId,
    jobType:    'SKU_IMAGE_UPLOAD',
    totalFiles: files.length,
  });

  setImmediate(() => processJob(job.job_id, files, uploadedBy, enterpriseId));

  return { jobId: job.job_id, status: 'QUEUED', totalFiles: files.length };
};

// Devuelve el estado de un job. Lanza 404 si no existe, 403 si el job no pertenece al usuario.
const getJobStatus = async (jobId, userId) => {
  const job = await jobRepo.findById(jobId);
  if (!job) throw svcError('Job no encontrado.', 404);
  if (job.user_id !== userId) throw svcError('No tenés acceso a este job.', 403);
  return job;
};

// Lista jobs del usuario, con paginación. Máximo 50 por página.
const listMyJobs = async (userId, { limit = 20, offset = 0 } = {}) => {
  const safeLimitLimit = Math.min(limit, 50);
  return jobRepo.listByUser(userId, { limit: safeLimitLimit, offset });
};

module.exports = { enqueueSkuImageUpload, getJobStatus, listMyJobs };
