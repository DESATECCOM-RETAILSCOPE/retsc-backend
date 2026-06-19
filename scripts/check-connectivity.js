/**
 * Script de diagnóstico de conectividad — RetailScope
 * --------------------------------------------------------------
 * Prueba cada servicio externo por separado y reporta cuál responde.
 * NO modifica nada (solo lecturas / pings). Seguro de correr.
 *
 * Uso:
 *   node scripts/check-connectivity.js
 *
 * Requiere las variables del .env. Usa los SDKs ya instalados
 * (@azure/storage-blob, mssql) y HTTP directo para los demás,
 * así no hace falta instalar paquetes nuevos para el diagnóstico.
 */

require('dotenv').config();

// Colores simples para la terminal
const ok   = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => console.log('  \x1b[31m✗\x1b[0m ' + m);
const info = (m) => console.log('  \x1b[90m·\x1b[0m ' + m);
const head = (m) => console.log('\n\x1b[1m\x1b[35m' + m + '\x1b[0m');

const results = [];
function record(name, success, detail) {
  results.push({ name, success, detail });
}

// Verifica que una variable exista y no esté vacía
function present(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

async function checkEnvVars() {
  head('1. Variables de entorno');
  const groups = {
    'SQL':          ['SQL_SERVER', 'SQL_PORT', 'SQL_USER', 'SQL_PASSWORD', 'SQL_DATABASE'],
    'Blob Storage': ['AZURE_STORAGE_CONNECTION_STRING', 'AZURE_GLOBAL_TRAINING_CONTAINER'],
    'AI Vision':    ['AZURE_VISION_ENDPOINT', 'AZURE_VISION_KEY'],
    'AI Search':    ['AZURE_SEARCH_ENDPOINT', 'AZURE_SEARCH_KEY', 'AZURE_SEARCH_INDEX'],
    'Queue':        ['AZURE_QUEUE_NAME'],
  };
  for (const [group, vars] of Object.entries(groups)) {
    const missing = vars.filter(v => !present(process.env[v]));
    if (missing.length === 0) ok(`${group}: todas presentes (${vars.length})`);
    else fail(`${group}: faltan o vacías → ${missing.join(', ')}`);
  }
}

async function checkSql() {
  head('2. Azure SQL');
  if (!present(process.env.SQL_SERVER)) { fail('Sin SQL_SERVER, salteo.'); record('SQL', false, 'sin config'); return; }
  let sql;
  try { sql = require('mssql'); } catch { fail('mssql no instalado'); record('SQL', false, 'sdk'); return; }
  try {
    const pool = await sql.connect({
      server:   process.env.SQL_SERVER,
      port:     Number(process.env.SQL_PORT) || 1433,
      user:     process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DATABASE,
      options:  { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 15000,
    });
    const r = await pool.request().query('SELECT COUNT(*) AS n FROM RETSC_AI_SKU_FEATURES');
    ok(`Conectado. RETSC_AI_SKU_FEATURES tiene ${r.recordset[0].n} filas.`);
    record('SQL', true, `${r.recordset[0].n} filas en SKU_FEATURES`);
    await pool.close();
  } catch (e) {
    fail('Error: ' + e.message);
    record('SQL', false, e.message);
  }
}

async function checkBlob() {
  head('3. Azure Blob Storage');
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!present(cs)) { fail('Sin connection string, salteo.'); record('Blob', false, 'sin config'); return; }
  let BlobServiceClient;
  try { ({ BlobServiceClient } = require('@azure/storage-blob')); }
  catch { fail('@azure/storage-blob no instalado'); record('Blob', false, 'sdk'); return; }
  try {
    const svc = BlobServiceClient.fromConnectionString(cs);
    const containerName = process.env.AZURE_GLOBAL_TRAINING_CONTAINER || 'global-sku-training';
    const container = svc.getContainerClient(containerName);
    const exists = await container.exists();
    if (!exists) { fail(`Container '${containerName}' no existe.`); record('Blob', false, 'container faltante'); return; }
    // Contar algunos blobs como prueba de lectura
    let count = 0;
    for await (const _ of container.listBlobsFlat()) { count++; if (count >= 5) break; }
    ok(`Conectado. Container '${containerName}' accesible (al menos ${count} blobs).`);
    record('Blob', true, `container ${containerName} OK`);
  } catch (e) {
    fail('Error: ' + e.message);
    record('Blob', false, e.message);
  }
}

async function checkQueue() {
  head('4. Azure Queue Storage');
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const queueName = process.env.AZURE_QUEUE_NAME || 'sku-image-processing';
  if (!present(cs)) { fail('Sin connection string, salteo.'); record('Queue', false, 'sin config'); return; }
  // Probamos vía REST sin instalar @azure/storage-queue:
  // construimos la URL del servicio de cola desde la connection string.
  try {
    const parts = Object.fromEntries(cs.split(';').filter(Boolean).map(kv => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }));
    const account = parts.AccountName;
    if (!account) { fail('No se pudo extraer AccountName de la connection string.'); record('Queue', false, 'parse'); return; }
    info(`Cuenta de storage: ${account}`);
    info(`Cola objetivo: ${queueName}`);
    info('Nota: la verificación real de la cola requiere @azure/storage-queue (aún no instalado).');
    info('Este check solo confirma que la cuenta de storage es legible (ver check 3).');
    record('Queue', null, 'requiere @azure/storage-queue para prueba completa');
  } catch (e) {
    fail('Error: ' + e.message);
    record('Queue', false, e.message);
  }
}

async function checkVision() {
  head('5. Azure AI Vision (OCR)');
  const endpoint = process.env.AZURE_VISION_ENDPOINT;
  const key = process.env.AZURE_VISION_KEY;
  if (!present(endpoint) || !present(key)) { fail('Sin endpoint o key, salteo.'); record('Vision', false, 'sin config'); return; }
  try {
    // Llamada mínima al endpoint de análisis con una imagen pública de prueba.
    // Usamos la API REST de Image Analysis 4.0 (feature: read = OCR).
    const base = endpoint.replace(/\/+$/, '');
    const url = `${base}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`;
    const testImage = 'https://learn.microsoft.com/azure/ai-services/computer-vision/images/printed_text.jpg';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: testImage }),
    });
    if (resp.ok) {
      const data = await resp.json();
      const text = data?.readResult?.blocks?.flatMap(b => b.lines.map(l => l.text)).join(' ') || '(sin texto)';
      ok(`Conectado. OCR de prueba devolvió: "${text.slice(0, 60)}..."`);
      record('Vision', true, 'OCR responde');
    } else {
      const body = await resp.text();
      fail(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
      record('Vision', false, `HTTP ${resp.status}`);
    }
  } catch (e) {
    fail('Error: ' + e.message);
    record('Vision', false, e.message);
  }
}

async function checkSearch() {
  head('6. Azure AI Search');
  const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
  const key = process.env.AZURE_SEARCH_KEY;
  const index = process.env.AZURE_SEARCH_INDEX || 'retsc-sku-vectors';
  if (!present(endpoint) || !present(key)) { fail('Sin endpoint o key, salteo.'); record('Search', false, 'sin config'); return; }
  try {
    const base = endpoint.replace(/\/+$/, '');
    // Pedimos la definición del índice (lectura, no modifica nada).
    const url = `${base}/indexes/${index}?api-version=2023-11-01`;
    const resp = await fetch(url, { headers: { 'api-key': key } });
    if (resp.ok) {
      const data = await resp.json();
      const fields = (data.fields || []).map(f => f.name);
      ok(`Conectado. Índice '${index}' existe con ${fields.length} campos.`);
      info('Campos: ' + fields.join(', '));
      record('Search', true, `índice ${index} OK`);
    } else {
      const body = await resp.text();
      fail(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
      record('Search', false, `HTTP ${resp.status}`);
    }
  } catch (e) {
    fail('Error: ' + e.message);
    record('Search', false, e.message);
  }
}

(async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  Diagnóstico de conectividad — RetailScope');
  console.log('══════════════════════════════════════════════');

  await checkEnvVars();
  await checkSql();
  await checkBlob();
  await checkQueue();
  await checkVision();
  await checkSearch();

  head('RESUMEN');
  for (const r of results) {
    const mark = r.success === true ? '\x1b[32m✓ OK   \x1b[0m'
               : r.success === false ? '\x1b[31m✗ FALLO\x1b[0m'
               : '\x1b[33m~ PARCIAL\x1b[0m';
    console.log(`  ${mark}  ${r.name.padEnd(8)} — ${r.detail}`);
  }
  console.log('');
  process.exit(0);
})();
