// Repositorio para la tabla RETSC_CONFIG — configuración operativa editable sin deploy
// (ej. SKU_MATCH_THRESHOLD, usado por skuSearchService.js). Esquema real (verificado con
// INFORMATION_SCHEMA): config_id (PK), clave (varchar), valor (varchar — todo se guarda como
// texto, cada consumidor parsea según su propio data_type), data_type, description,
// updated_by, updated_at.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_CONFIG';

// Devuelve { valor, data_type } para una clave, o null si no existe la fila.
const findByKey = async (clave) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('clave', sql.VarChar(100), clave)
    .query(`SELECT valor, data_type FROM ${TABLE} WHERE clave = @clave`);
  return r.recordset[0] ?? null;
};

module.exports = { findByKey };
