const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT) || 1435,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
  connectionTimeout: 30000,
  requestTimeout: 30000,
};

let pool = null;

const getPool = async () => {
  if (!pool) {
    try {
      pool = await sql.connect(config);
      console.log('✅ Conectado a MSSQL exitosamente');
    } catch (err) {
      console.error('❌ Error conectando a MSSQL:', err.message);
      pool = null;
      throw err;
    }
  }
  return pool;
};

module.exports = { getPool, sql };
