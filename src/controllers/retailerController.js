// Controller para RETSC_OP_RETAILER — catálogo de PDVs. Rutas asociadas: /api/retailers
//
// Consumido por el mobile en el Paso 0 de la guía "Fotos de Visita" v1.9: el mapa de
// selección de tienda necesita Retailer_id + lat/lng reales antes de poder abrir una visita
// (POST /api/visits recibe retailerId en el body).

const retailerRepo = require('../repositories/retailerRepo');

function handleError(res, err) {
  console.error('[retailer]', err);
  return res.status(500).json({ success: false, message: err.message });
}

// GET /api/retailers
const listAll = async (req, res) => {
  try {
    const retailers = await retailerRepo.list();
    return res.json({ success: true, retailers });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = { listAll };
