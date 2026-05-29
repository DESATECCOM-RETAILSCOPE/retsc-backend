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

// DEBUG TEMPORAL — borrar después de resolver el problema
const debugConfig = () => {
  console.log('[DB DEBUG] SQL_SERVER  :', process.env.SQL_SERVER);
  console.log('[DB DEBUG] SQL_DATABASE:', process.env.SQL_DATABASE);
  console.log('[DB DEBUG] SQL_USER    :', process.env.SQL_USER);
  console.log('[DB DEBUG] SQL_PORT    :', process.env.SQL_PORT || '1433 (default)');
  console.log('[DB DEBUG] SQL_PASSWORD:', process.env.SQL_PASSWORD ? `SET (${process.env.SQL_PASSWORD.length} chars)` : 'NOT SET');
};

const getPool = async () => {
  if (pool && pool.connected) return pool;

  // Pool exists but connection dropped — close it before reconnecting
  if (pool) {
    try { await pool.close(); } catch (_) {}
    pool = null;
  }

  console.log('[DB DEBUG] Intentando conectar a MSSQL...');
  debugConfig();

  try {
    pool = await sql.connect(config);
    pool.on('error', (err) => {
      console.error('❌ MSSQL pool error:', err.message);
      pool = null;
    });
    console.log('✅ Conectado a MSSQL exitosamente');
  } catch (err) {
    console.error('❌ Error conectando a MSSQL:', err.message);
    console.error('[DB DEBUG] Error completo:', err);
    pool = null;
    throw err;
  }

  return pool;
};

module.exports = { getPool, sql };
