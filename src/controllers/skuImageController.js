// Controller para el módulo de imágenes de SKU.
// Rutas asociadas: /api/sku-images

const path                   = require('path');
const fs                     = require('fs').promises;
const crypto                 = require('crypto');
const skuImageService        = require('../services/skuImageService');
const jobService             = require('../services/jobService');
const { validateImage }      = require('../services/imageValidationService');
const skuFeatureRepo         = require('../repositories/skuFeatureRepo');
const { insertValidationLog} = require('../repositories/skuImageLogRepo');

const BACKEND_ROOT   = path.join(__dirname, '..', '..');
const MOCK_BASE_PATH = () => path.join(BACKEND_ROOT, process.env.BLOB_MOCK_BASE_PATH || 'data/blob-mock');

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

// POST /api/sku-images/:featureId/validate
// Valida la calidad de una imagen ya registrada en RETSC_AI_SKU_FEATURES.
// Flujo: busca feature → resuelve path local del blob → analiza → actualiza validation_status → log.
// En modo mock lee el archivo local directamente.
// En modo Azure descarga el blob a un temporal en uploads-temp/ antes de analizar.
const validateImageQuality = async (req, res) => {
  const featureId = parseInt(req.params.featureId, 10);
  if (isNaN(featureId)) {
    return res.status(400).json({ success: false, message: 'Feature ID inválido.' });
  }

  const feature = await skuFeatureRepo.findById(featureId).catch(() => null);
  if (!feature) {
    return res.status(404).json({ success: false, message: `Feature ${featureId} no encontrado.` });
  }
  if (!feature.image_url) {
    return res.status(422).json({ success: false, message: 'El feature no tiene image_url asociada.' });
  }

  let tempPath = null;
  let imagePath;

  try {
    const imageUrl = feature.image_url;
    const mode     = (process.env.BLOB_STORAGE_MODE || 'mock').toLowerCase();

    if (mode === 'mock' || imageUrl.startsWith('/blob-mock/')) {
      // Mock: resolver path local quitando el prefijo /blob-mock/
      const relativePart = imageUrl.replace(/^\/blob-mock\//, '');
      imagePath = path.join(MOCK_BASE_PATH(), relativePart);
    } else {
      // Azure: descargar el blob a un archivo temporal
      const { BlobServiceClient } = require('@azure/storage-blob');
      const connStr   = process.env.AZURE_STORAGE_CONNECTION_STRING;
      const container = process.env.AZURE_GLOBAL_TRAINING_CONTAINER || 'global-sku-training';
      if (!connStr) {
        return res.status(503).json({ success: false, message: 'AZURE_STORAGE_CONNECTION_STRING no configurada.' });
      }
      // Extraer blobPath de la URL de Azure
      const blobPath = new URL(imageUrl).pathname.split(`/${container}/`)[1];
      if (!blobPath) {
        return res.status(422).json({ success: false, message: 'No se pudo extraer el blobPath de la URL.' });
      }

      const client  = BlobServiceClient.fromConnectionString(connStr).getContainerClient(container).getBlobClient(blobPath);
      const tmpName = `validate-${featureId}-${crypto.randomUUID()}.tmp`;
      tempPath  = path.join(BACKEND_ROOT, 'uploads-temp', tmpName);
      await client.downloadToFile(tempPath);
      imagePath = tempPath;
    }

    const result = await validateImage(imagePath);

    // Persistir validation_status en RETSC_AI_SKU_FEATURES
    await skuFeatureRepo.updateValidationStatus(featureId, result.status);

    // Registrar en RETSC_LOG_IMAGE_UPLOAD
    await insertValidationLog({
      enterpriseId:     req.user.enterpriseId,
      skuId:            feature.sku_id,
      featureId,
      imageUrl:         feature.image_url,
      validationStatus: result.status,
      failures:         result.failures,
    }).catch(err => console.warn('[validate] no se pudo insertar log:', err.message));

    return res.json({
      success:   true,
      featureId,
      status:    result.status,
      metrics:   result.metrics,
      failures:  result.failures,
    });

  } catch (err) {
    return handleError(res, err);
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => {});
  }
};

module.exports = { uploadImages, getJobStatus, listMyJobs, listBySku, validateImageQuality };
