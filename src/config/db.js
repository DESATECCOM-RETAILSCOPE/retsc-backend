const sql = require('mssql');

const config = {
  server: process.env.SQL_SERVER,
  port: parseInt(process.env.SQL_PORT) || 1433,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  options: {
    encrypt: true,
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

// DEBUG TEMPORAL — borrar después de resolver el problema
const debugConfig = () => {
  console.log('[DB DEBUG] SQL_SERVER  :', process.env.SQL_SERVER);
  console.log('[DB DEBUG] SQL_DATABASE:', process.env.SQL_DATABASE);
  console.log('[DB DEBUG] SQL_USER    :', process.env.SQL_USER);
  console.log('[DB DEBUG] SQL_PORT    :', process.env.SQL_PORT || '1433 (default)');
  console.log('[DB DEBUG] SQL_PASSWORD:', process.env.SQL_PASSWORD ? `SET (${process.env.SQL_PASSWORD.length} chars)` : 'NOT SET');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reintentos con backoff ante un primer connect frío (caso real, 2026-11-19: 5 días sin
// tráfico → el primer login del día falló con "operation timed out for an unknown reason"
// — un TimeoutError del pool (tarn), no un error de credenciales — y el reintento manual del
// usuario 90s después conectó al toque). Sin esto, ese error crudo del driver se mandaba tal
// cual al usuario (ver authController.js: `message: err.message`), obligándolo a reintentar
// él mismo. 3 intentos cubre un cold-start típico sin dejar una request colgada
// indefinidamente si la base realmente está caída.
const CONNECT_ATTEMPTS = 3;

const getPool = async () => {
  if (pool && pool.connected) return pool;

  // Pool exists but connection dropped — close it before reconnecting
  if (pool) {
    try { await pool.close(); } catch (_) {}
    pool = null;
  }

  let lastErr;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    console.log(`[DB DEBUG] Intentando conectar a MSSQL (intento ${attempt}/${CONNECT_ATTEMPTS})...`);
    debugConfig();

    try {
      pool = await sql.connect(config);
      pool.on('error', (err) => {
        console.error('❌ MSSQL pool error:', err.message);
        pool = null;
      });
      console.log('✅ Conectado a MSSQL exitosamente');
      return pool;
    } catch (err) {
      lastErr = err;
      pool = null;
      console.error(`❌ Error conectando a MSSQL (intento ${attempt}/${CONNECT_ATTEMPTS}):`, err.message);
      if (attempt < CONNECT_ATTEMPTS) {
        const waitMs = 2000 * attempt;
        console.log(`[DB DEBUG] Reintentando en ${waitMs}ms — probable cold start de la base...`);
        await sleep(waitMs);
      }
    }
  }

  console.error('[DB DEBUG] Error completo (último intento):', lastErr);
  throw lastErr;
};

module.exports = { getPool, sql };
