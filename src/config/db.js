const sql = require('mssql');

const config = {
  server: process.env.SQL_SERVER,
  port: parseInt(process.env.SQL_PORT) || 1433,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: false,
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
