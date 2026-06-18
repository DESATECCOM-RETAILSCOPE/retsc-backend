/**
 * Migración: agrega Supplier, client_category, client_subcategory a RETSC_OP_PRODUCTS.
 * Uso: node scripts/migrate-add-sku-columns.js
 * Idempotente — salta columnas que ya existen.
 */
require('dotenv').config();
const sql = require('mssql');

const COLUMNS = [
  { name: 'Supplier',           def: 'VARCHAR(200) NULL' },
  { name: 'client_category',    def: 'VARCHAR(200) NULL' },
  { name: 'client_subcategory', def: 'VARCHAR(200) NULL' },
];

async function run() {
  const pool = await sql.connect({
    server:   process.env.SQL_SERVER,
    port:     parseInt(process.env.SQL_PORT) || 1433,
    user:     process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DATABASE,
    options:  { encrypt: true, trustServerCertificate: false },
  });

  for (const col of COLUMNS) {
    const check = await pool.request().query(`
      SELECT COUNT(*) AS cnt
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME  = 'RETSC_OP_PRODUCTS'
        AND COLUMN_NAME = '${col.name}'
    `);

    if (check.recordset[0].cnt > 0) {
      console.log(`✅ ${col.name} ya existe — omitida.`);
      continue;
    }

    await pool.request().query(`
      ALTER TABLE RETSC_OP_PRODUCTS ADD ${col.name} ${col.def}
    `);
    console.log(`✅ Columna ${col.name} agregada a RETSC_OP_PRODUCTS.`);
  }

  await pool.close();
}

run().catch(err => {
  console.error('❌ Migración fallida:', err.message);
  process.exit(1);
});
