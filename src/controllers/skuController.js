const fs         = require('fs').promises;
const skuService = require('../services/skuService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[sku]', err);
  return res.status(status).json({ success: false, message: err.message });
}

// POST /api/skus/upload-excel
const uploadSkuExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Archivo inválido o columnas faltantes' });
    }

    const { enterpriseCategoryId } = req.body;
    console.log('[sku] enterpriseCategoryId recibido:', enterpriseCategoryId, '| enterpriseId:', req.user.enterpriseId);
    if (!enterpriseCategoryId) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ success: false, message: 'enterpriseCategoryId es requerido' });
    }

    const result = await skuService.processSkuExcel(
      req.file.path,
      enterpriseCategoryId,
      req.user.enterpriseId,
    );

    await fs.unlink(req.file.path).catch(() => {});

    return res.json({
      success: true,
      metrics: result.metrics,
      errors:  result.errors,
    });
  } catch (err) {
    await fs.unlink(req.file?.path).catch(() => {});

    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('[sku] upload-excel error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Error interno', status: 'failed' });
  }
};

module.exports = { uploadSkuExcel };
