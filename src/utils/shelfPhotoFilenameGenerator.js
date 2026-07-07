// Genera la ruta de blob para una foto de góndola dentro del container global
// (AZURE_GLOBAL_SHELF_CONTAINER, default: global-shelf-training).
//
// Formato: {categorySlug}/{canal}/{hash8}.jpg
//   categorySlug  = slug de la categoría de almacenamiento (padre de la smart category)
//   canal         = 'omt' | 'dtt' | 'convenience'
//   hash8         = primeros 8 caracteres del SHA-256 (suficiente para unicidad práctica)

const { normalizeName } = require('./categoryNameNormalizer');

function generateBlobPath({ categoryDsc, canal, hash }) {
  const slug    = normalizeName(categoryDsc);
  const ch      = canal.toLowerCase();
  const hash8   = hash.substring(0, 8);
  return `${slug}/${ch}/${hash8}.jpg`;
}

module.exports = { generateBlobPath };
