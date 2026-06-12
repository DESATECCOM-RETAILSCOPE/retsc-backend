/**
 * Migración: agrega la columna Brand a RETSC_OP_PRODUCTS si no existe.
 * Uso: node scripts/migrate-add-brand.js
 */
require('dotenv').config();
const sql = require('mssql');

async function run() {
  const pool = await sql.connect({
    server:   process.env.SQL_SERVER,
    port:     parseInt(process.env.SQL_PORT) || 1433,
    user:     process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DATABASE,
    options:  { encrypt: true, trustServerCertificate: false },
  });

  // Verificar si la columna ya existe (idempotente)
  const check = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME  = 'RETSC_OP_PRODUCTS'
      AND COLUMN_NAME = 'Brand'
  `);

  if (check.recordset[0].cnt > 0) {
    console.log('✅ La columna Brand ya existe en RETSC_OP_PRODUCTS — nada que hacer.');
    await pool.close();
    return;
  }

  await pool.request().query(`
    ALTER TABLE RETSC_OP_PRODUCTS
    ADD Brand VARCHAR(200) NULL
  `);

  console.log('✅ Columna Brand agregada a RETSC_OP_PRODUCTS.');
  await pool.close();
}

run().catch(err => {
  console.error('❌ Migración fallida:', err.message);
  process.exit(1);
});
