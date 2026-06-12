// Genera el nombre de archivo canónico que se guarda en Blob Storage.
//
// Regla de naming (decisión de jefatura, Mini Pasada 2.1):
//   - Imagen primary (is_primary=true):  {EAN}.{ext}          — sin sufijo de vista
//   - Imágenes secundarias:              {EAN}_{vista}.{ext}   — con sufijo de vista
//   - Huérfanas:                         {EAN}_{vista}.{ext}   — siempre con sufijo (isPrimary no aplica)
//
// Los nombres generados son deterministas: mismo EAN + vista + isPrimary + ext → mismo nombre.
// Esto es intencional: facilita la deduplicación y el matching retroactivo de huérfanas.

function generateFilename({ ean, view, ext, isPrimary }) {
  if (isPrimary) return `${ean}.${ext}`;
  return `${ean}_${view}.${ext}`;
}

module.exports = { generateFilename };
