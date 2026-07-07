// Controller para carga de fotos de góndola (Issue 7.2).
// Solo Admin puede acceder — verificado por requireAdmin en el router.

const fs                    = require('fs').promises;
const shelfPhotoUploadService = require('../services/shelfPhotoUploadService');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[shelfPhoto]', err);
  return res.status(status).json({ success: false, message: err.message });
}

// POST /api/shelf-photos/upload
// Body (multipart): image (file), dtcCategoryId (int), canal (OMT|DTT|CONVENIENCE)
const upload = async (req, res) => {
  const tempPath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Se requiere una imagen.' });
    }

    const buffer = await fs.readFile(tempPath);
    const result = await shelfPhotoUploadService.uploadShelfPhoto({
      buffer,
      originalname:  req.file.originalname,
      dtcCategoryId: req.body.dtcCategoryId,
      canal:         req.body.canal,
      enterpriseId:  req.user.enterpriseId,
    });

    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  } finally {
    // Limpia el archivo temporal independientemente del resultado.
    if (tempPath) fs.unlink(tempPath).catch(() => {});
  }
};

module.exports = { upload };
