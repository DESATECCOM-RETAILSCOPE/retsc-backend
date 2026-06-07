// Controller para el módulo de imágenes de SKU.
// Rutas asociadas: /api/sku-images

const skuImageService = require('../services/skuImageService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[skuImage]', err);
  return res.status(status).json({ success: false, message: err.message });
}

// POST /api/sku-images/upload
// Recibe hasta 200 imágenes vía multipart (field: 'images').
// Procesa síncronamente y devuelve el resumen del batch.
const uploadImages = async (req, res) => {
  try {
    // multer puede abortar con un error antes de llegar al controller
    // (fileFilter, fileSize); esos se manejan en el error handler del router.
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No se enviaron imágenes.' });
    }

    const result = await skuImageService.processBatch({
      files:        req.files,
      uploadedBy:   req.user.userId,
      enterpriseId: req.user.enterpriseId,
    });

    return res.json({ success: true, ...result });
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

module.exports = { uploadImages, listBySku };
