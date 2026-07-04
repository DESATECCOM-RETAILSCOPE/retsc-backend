// Generador de nombres de archivo canónicos para fotos de góndola globales (Issue 7.2).
//
// El nombre lo genera el sistema — nunca viene del usuario — para evitar colisiones y
// mantener una convención uniforme en el container global-shelf-training.
//
// Formato: {categoriaSlug}-{CANAL}-{timestamp}-{uuid}.jpg
// Ejemplo:  desodorantes-OMT-1719500000-a1b2c3d4.jpg
//
// NOTA: timestamp en segundos Unix (Math.floor(Date.now()/1000)) para mantener orden
// cronológico en listados de blob sin necesidad de leer metadata de Azure.
//
// TODOs conocidos: ninguno.

const crypto = require('crypto');

// Devuelve el nombre de archivo canónico para una foto de góndola.
// Si no se pasan timestamp/uuid los genera internamente.
function generateFilename({ categoriaSlug, canal, timestamp, uuid }) {
  const t   = timestamp ?? Math.floor(Date.now() / 1000);
  const uid = uuid      ?? crypto.randomUUID().slice(0, 8);
  return `${categoriaSlug}-${canal.toUpperCase()}-${t}-${uid}.jpg`;
}

module.exports = { generateFilename };
