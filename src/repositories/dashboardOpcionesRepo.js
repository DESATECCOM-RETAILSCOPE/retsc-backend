// Dashboard web (Parte B): opciones de los filtros (categoría, cadena, formato).
//
// Devuelve solo los valores que tienen datos de cumplimiento para la empresa, así
// nadie elige una combinación que siempre sale vacía. Lee del snapshot de
// cumplimiento (la misma fuente que las tarjetas), no del catálogo actual:
// cadena y formato son los que quedaron congelados en cada visita.

const { getPool, sql } = require('../config/db');

const COMPLIANCE = 'RETSC_EX_ASSORTMENT_COMPLIANCE';
const CATEGORIES = 'RETSC_OP_CATEGORIES';
const CHAINS     = 'RETSC_OP_SMKTCHAINS';

async function opciones(enterpriseId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`
      SELECT DISTINCT c.category AS id, cat.Category_dsc AS nombre
      FROM ${COMPLIANCE} c
      LEFT JOIN ${CATEGORIES} cat ON cat.Category_id = c.category
      WHERE c.enterprise_id = @enterpriseId AND c.category IS NOT NULL
      ORDER BY nombre;

      SELECT DISTINCT c.Supermarketchain_id AS id, ch.Supermarketchain AS nombre
      FROM ${COMPLIANCE} c
      LEFT JOIN ${CHAINS} ch ON ch.Supermarketchain_id = c.Supermarketchain_id
      WHERE c.enterprise_id = @enterpriseId AND c.Supermarketchain_id IS NOT NULL
      ORDER BY nombre;

      SELECT DISTINCT LTRIM(RTRIM(c.Format)) AS valor
      FROM ${COMPLIANCE} c
      WHERE c.enterprise_id = @enterpriseId
        AND c.Format IS NOT NULL AND LTRIM(RTRIM(c.Format)) <> ''
      ORDER BY valor;
    `);

  const [categorias = [], cadenas = [], formatos = []] = r.recordsets;
  return {
    categorias: categorias.map((x) => ({ id: x.id, nombre: x.nombre ?? `Categoría ${x.id}` })),
    cadenas:    cadenas.map((x) => ({ id: x.id, nombre: x.nombre ?? `Cadena ${x.id}` })),
    formatos:   formatos.map((x) => x.valor),
  };
}

module.exports = { opciones };
