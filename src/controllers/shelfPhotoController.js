// Controller para la carga de fotos de góndola globales (Issue 7.2).
// Rutas asociadas: /api/shelf-photos
//
// Sigue el mismo patrón que skuImageController: handleError con statusCode,
// limpieza del temp de multer en finally.

const fs                      = require('fs').promises;
const { uploadShelfPhoto }    = require('../services/shelfPhotoUploadService');

function handleError(res, err) {
  const status    = err.statusCode || 500;
  const errorCode = err.errorCode  || undefined;
  if (status === 500) console.error('[shelfPhoto]', err);
  return res.status(status).json({
    success: false,
    ...(errorCode && { errorCode }),
    message: err.message,
  });
}

// POST /api/shelf-photos/upload
// Multipart: campo de archivo "photo" + campos dtcCategoryId y canal.
// Solo Admins (ver requireRole en la ruta).
const uploadPhoto = async (req, res) => {
  const filePath = req.file?.path ?? null;

  try {
    // Validación de archivo (multer ya filtra extensión y tamaño; aquí verificamos presencia).
    if (!req.file) {
      return res.status(400).json({
        success:   false,
        errorCode: 'ERR_ARCHIVO_REQUERIDO',
        message:   'Se requiere el campo "photo" con una imagen (jpg/jpeg/png/webp, máx 10 MB).',
      });
    }

    const { dtcCategoryId, canal } = req.body;

    // Leer buffer aquí para pasarlo al servicio y poder hacer unlink en finally.
    const buffer = await fs.readFile(req.file.path);

    const result = await uploadShelfPhoto({
      buffer,
      dtcCategoryId,
      canal,
      uploadedBy: req.user.userId,
    });

    return res.status(201).json({ success: true, ...result });

  } catch (err) {
    return handleError(res, err);
  } finally {
    // Limpia siempre el archivo temporal de multer, independientemente del resultado.
    if (filePath) await fs.unlink(filePath).catch(() => {});
  }
};

module.exports = { uploadPhoto };
