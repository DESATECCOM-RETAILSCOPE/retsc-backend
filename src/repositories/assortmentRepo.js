// Repositorio para RETSC_OP_ASSORTMENT (sección 8.2 de la guía "Fotos de Visita" v1.9 —
// "faltantes del surtido propio"). Tabla nueva — ver migración 008_create_visit_photo_pipeline.sql.
// No existía ningún catálogo de surtido autorizado/obligatorio en este repo antes de esto.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_ASSORTMENT';

// Query exacta de la sección 8.2 de la guía: surtido obligatorio del enterprise para una
// categoría que NO aparece entre lo detectado en la visita (visitId ya resuelve el join
// contra RETSC_EX_SHELFPHOTO_DETECTION del lado del llamador — ver
// shelfPhotoDetectionRepo.listDetectedSkuIdsByVisit — así esta consulta no necesita conocer
// la tabla de detecciones, y evita repetir el join aquí).
const listMissingMandatory = async (enterpriseId, categoryId, detectedSkuIds) => {
  const pool = await getPool();
  const req = pool.request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .input('categoryId',   sql.Int, categoryId);

  let excludeClause = '';
  if (detectedSkuIds && detectedSkuIds.length > 0) {
    const placeholders = detectedSkuIds.map((id, i) => {
      req.input(`sku${i}`, sql.Int, id);
      return `@sku${i}`;
    });
    excludeClause = `AND a.sku_id NOT IN (${placeholders.join(', ')})`;
  }

  const r = await req.query(`
    SELECT a.sku_id, s.Product_dsc
    FROM ${TABLE} a
    JOIN RETSC_OP_SKUS s ON s.SKU_ID = a.sku_id
    WHERE a.enterprise_id = @enterpriseId
      AND a.category_id = @categoryId
      AND a.is_mandatory = 1
      ${excludeClause}
  `);
  return r.recordset;
};

module.exports = { listMissingMandatory };
