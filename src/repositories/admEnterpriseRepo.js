/**
 * admEnterpriseRepo.js — Consulta mínima sobre empresas para el módulo administrativo.
 *
 * Para qué sirve: comprobar que una empresa existe ANTES de escribir, para devolver un
 *   mensaje claro ("La empresa indicada no existe") en lugar del error técnico de la
 *   llave foránea. La FK de la base sigue siendo la protección real.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 */

const { getPool, sql } = require('../config/db');

// true si existe una fila en RETSC_OP_ENTERPRISE con ese Enterprise_id.
const exists = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query('SELECT 1 AS found FROM RETSC_OP_ENTERPRISE WHERE Enterprise_id = @enterpriseId');
  return r.recordset.length > 0;
};

module.exports = { exists };
