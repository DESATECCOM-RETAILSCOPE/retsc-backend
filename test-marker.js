// test-marker.js
require('dotenv').config();
const blob = require('./src/services/blobStorageService');
(async () => {
  try {
    await blob.createMarker({ containerName: 'global-sku-training', prefix: 'dtc-prueba-diagnostico' });
    console.log('✓ Marker creado OK en Azure');
  } catch (e) {
    console.error('✗ Error real:', e.message);
  }
})();
