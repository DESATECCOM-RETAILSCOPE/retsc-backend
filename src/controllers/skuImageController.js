// Controller para el módulo de imágenes de SKU.
// Rutas asociadas: /api/sku-images

const skuImageService = require('../services/skuImageService');
const jobService      = require('../services/jobService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[skuImage]', err);
  return res.status(status).json({ success: false, message: err.message });
}

// POST /api/sku-images/upload
// Encola el batch y devuelve 202 inmediatamente con { jobId, status, totalFiles }.
// Los archivos se procesan en background; usar GET /jobs/:jobId para polling.
const uploadImages = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No se enviaron imágenes.' });
    }

    const result = await jobService.enqueueSkuImageUpload({
      files:        req.files,
      uploadedBy:   req.user.userId,
      enterpriseId: req.user.enterpriseId,
    });

    return res.status(202).json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/sku-images/jobs/:jobId
// Devuelve el estado y contadores del job. 404 si no existe, 403 si es de otro usuario.
const getJobStatus = async (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId, 10);
    if (isNaN(jobId)) {
      return res.status(400).json({ success: false, message: 'Job ID inválido.' });
    }
    const job = await jobService.getJobStatus(jobId, req.user.userId);
    return res.json({ success: true, job });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/sku-images/jobs?limit=&offset=
// Lista los jobs del usuario autenticado, del más reciente al más viejo.
const listMyJobs = async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  ?? '20', 10) || 20, 50);
    const offset = parseInt(req.query.offset ?? '0',  10) || 0;
    const jobs   = await jobService.listMyJobs(req.user.userId, { limit, offset });
    return res.json({ success: true, jobs });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/sku-images/sku/:skuId
// Lista imágenes activas de un SKU.
const listBySku = async (req, res) => {
  try {
    const skuId = parseInt(req.params.skuId, 10);
    if (isNaN(skuId)) {
      return res.status(400).json({ success: false, message: 'SKU ID inválido.' });
    }
    const images = await skuImageService.listImagesBySkuId(skuId);
    return res.json({ success: true, images });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { uploadImages, getJobStatus, listMyJobs, listBySku };
