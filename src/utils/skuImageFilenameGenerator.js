// Genera el nombre de archivo canónico que se guarda en Blob Storage.
// Formato: {EAN}_{vista}.{ext}
// Ejemplo: '7501234567890_front.jpg'
//
// Los nombres generados son deterministas: mismo EAN + vista + ext → mismo nombre.
// Esto es intencional: facilita la deduplicación y el matching retroactivo de huérfanas.

function generateFilename({ ean, view, ext }) {
  return `${ean}_${view}.${ext}`;
}

module.exports = { generateFilename };
