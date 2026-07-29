// Reset del ambiente BETA (recursos "-prod" con datos descartables, sin clientes reales) para
// dejarlo en cero antes de una carga de prueba E2E. DESTRUCTIVO e irreversible — por eso:
//
//   1. Lista BLANCA (no negra): solo se tocan las tablas/containers listados explícitamente
//      abajo. Nada de DROP. No se tocan RETSC_OP_USERS/ENTERPRISE/USRSXENTERP/ROLES ni ninguna
//      tabla no listada (incluye tablas hoy vacías como RETSC_OP_ASSORTMENT/PLANOGRAM/etc. —
//      quedan fuera de scope aunque estén en 0, no se asume que "vacío = seguro de tocar").
//   2. EXPECTED_ENV: verifica que SQL_SERVER/SQL_DATABASE, la cuenta de storage (parseada de
//      AZURE_STORAGE_CONNECTION_STRING) y el host de Custom Vision coincidan con lo hardcodeado
//      acá. Si no coincide (ambiente equivocado en .env) -> aborta sin tocar nada.
//   3. Confirmación escrita: no hay --force/--yes. Solo procede si el operador tipea la frase
//      exacta CONFIRM_PHRASE por stdin. Cualquier otra cosa (incluido Enter vacío) -> aborta.
//   4. Antes de pedir la confirmación se imprime el inventario completo (qué tabla/container/
//      project y cuántas filas/blobs tiene HOY) para que el operador vea qué va a borrar.
//
// Contenedores Blob del storage account: ese storage también aloja containers de sistema de un
// Azure Function (app-package-func-*, azure-webjobs-hosts, azure-webjobs-secrets) y dos más
// (execution-raw/execution-results) que por nombre parecen del pipeline cognitivo externo — NO
// se tocan, no están en la lista blanca aunque existan en la misma cuenta de storage.

require('dotenv').config();
const readline = require('readline');
const { getPool }           = require('../src/config/db');
const { BlobServiceClient } = require('@azure/storage-blob');

const EXPECTED_ENV = {
  sqlServer:      'sql-rscope-prod.database.windows.net',
  sqlDatabase:    'sqldb-rscope-prod',
  storageAccount: 'storagescopeprod',
  cvHost:         'cvrscopeaiprod.cognitiveservices.azure.com',
};

const CONFIRM_PHRASE = 'BORRAR RSCOPE-BETA';

// Lista blanca de tablas a vaciar (DELETE, no DROP), en orden seguro para FKs (hijas primero).
// Todo lo que NO está acá queda intacto, exista o no, tenga filas o no.
const TABLES_WHITELIST = [
  'RETSC_AI_TRAINING_ANNOTATIONS',   // anotaciones de fotos de góndola (bbox, cv_region_id)
  'RETSC_EX_SHELFPHOTO_DETECTION',   // detecciones sobre fotos de góndola (si las hay)
  'RETSC_EX_SHELFPHOTO',             // fotos de góndola
  'RETSC_LOG_JOBS',                  // jobs de carga de imágenes SKU
  'RETSC_LOG_IMAGE_UPLOAD',          // log de carga de imágenes SKU
  'RETSC_LOG_SKU_UPLOAD',            // log de carga de SKUs por Excel
  'RETSC_AI_SKU_IMAGE_METADATA',     // metadata de imágenes SKU (FK -> SKU_FEATURES)
  'RETSC_AI_SKU_FEATURES',           // features/imágenes de SKU
  'RETSC_OP_ENTERPRISE_PRODUCT_SEG', // segmentación SKU por empresa (brand/categoria/volumen)
  'RETSC_OP_SKUS',                   // catálogo SKU global
  'RETSC_AI_DETECTION_MODELS',       // modelos de detección por categoría
  'RETSC_INF_GLOBAL_BLOB_CONTAINERS',// tracking de containers globales creados por categoría
  'RETSC_OP_ENTERPRISE_CATEGORIES',  // selección de categorías por empresa (FK -> CATEGORIES)
  'RETSC_OP_CATEGORIES',             // taxonomía de prueba — se recarga en Fase 2
];

// Containers Blob que este repo realmente usa (ver blobStorageService.js / CLAUDE.md) — se
// vacían (no se borran los containers en sí, quedan creados y listos para Fase 3/4).
const CONTAINERS_WHITELIST = [
  process.env.AZURE_GLOBAL_TRAINING_CONTAINER || 'global-sku-training',
  process.env.AZURE_GLOBAL_SHELF_CONTAINER    || 'global-shelf-training',
];

function assertExpectedEnv() {
  const errors = [];
  if (process.env.SQL_SERVER !== EXPECTED_ENV.sqlServer) {
    errors.push(`SQL_SERVER esperado "${EXPECTED_ENV.sqlServer}", encontrado "${process.env.SQL_SERVER}"`);
  }
  if (process.env.SQL_DATABASE !== EXPECTED_ENV.sqlDatabase) {
    errors.push(`SQL_DATABASE esperado "${EXPECTED_ENV.sqlDatabase}", encontrado "${process.env.SQL_DATABASE}"`);
  }
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
  const accountMatch = /AccountName=([^;]+)/.exec(cs);
  const account = accountMatch ? accountMatch[1] : null;
  if (account !== EXPECTED_ENV.storageAccount) {
    errors.push(`Storage account esperado "${EXPECTED_ENV.storageAccount}", encontrado "${account}"`);
  }
  const cvHost = (process.env.CUSTOM_VISION_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (cvHost !== EXPECTED_ENV.cvHost) {
    errors.push(`Custom Vision endpoint esperado "${EXPECTED_ENV.cvHost}", encontrado "${cvHost}"`);
  }

  if (errors.length) {
    console.error('\n❌ VERIFICACIÓN DE AMBIENTE FALLÓ — no coincide con EXPECTED_ENV. Abortando sin tocar nada.\n');
    errors.forEach(e => console.error(`   - ${e}`));
    process.exit(1);
  }
  console.log('✓ Ambiente verificado — coincide con EXPECTED_ENV (sql-rscope-prod / storagescopeprod / cvrscopeaiprod).');
}

async function listCvProjects() {
  const base = (process.env.CUSTOM_VISION_ENDPOINT || '').replace(/\/$/, '');
  const res = await fetch(`${base}/customvision/v3.3/training/projects`, {
    headers: { 'Training-key': process.env.CUSTOM_VISION_TRAINING_KEY },
  });
  if (!res.ok) throw new Error(`CV ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function deleteCvProject(projectId) {
  const base = (process.env.CUSTOM_VISION_ENDPOINT || '').replace(/\/$/, '');
  const res = await fetch(`${base}/customvision/v3.3/training/projects/${projectId}`, {
    method: 'DELETE',
    headers: { 'Training-key': process.env.CUSTOM_VISION_TRAINING_KEY },
  });
  if (!res.ok && res.status !== 404) throw new Error(`CV ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function countBlobs(containerClient) {
  let count = 0;
  for await (const _ of containerClient.listBlobsFlat()) count++;
  return count;
}

async function buildInventory() {
  const pool = await getPool();
  const tableCounts = [];
  for (const table of TABLES_WHITELIST) {
    const r = await pool.request().query(`SELECT COUNT(*) AS c FROM [${table}]`);
    tableCounts.push({ table, count: r.recordset[0].c });
  }

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const blobCounts = [];
  if (connStr) {
    const svc = BlobServiceClient.fromConnectionString(connStr);
    for (const containerName of CONTAINERS_WHITELIST) {
      const cc = svc.getContainerClient(containerName);
      const exists = await cc.exists();
      const count = exists ? await countBlobs(cc) : 0;
      blobCounts.push({ containerName, exists, count });
    }
  }

  let cvProjects = [];
  if (process.env.CUSTOM_VISION_TRAINING_KEY && process.env.CUSTOM_VISION_ENDPOINT) {
    cvProjects = await listCvProjects();
  }

  return { tableCounts, blobCounts, cvProjects };
}

function printInventory({ tableCounts, blobCounts, cvProjects }) {
  console.log('\n=== INVENTARIO — esto es lo que se va a BORRAR ===\n');
  console.log(`SQL Server objetivo: ${process.env.SQL_SERVER}`);
  console.log(`SQL Database objetivo: ${process.env.SQL_DATABASE}\n`);
  console.log('Tablas (DELETE, lista blanca):');
  let totalRows = 0;
  for (const { table, count } of tableCounts) {
    console.log(`  ${table.padEnd(35)} ${count} filas`);
    totalRows += count;
  }
  console.log(`  TOTAL: ${totalRows} filas en ${tableCounts.length} tablas\n`);

  console.log(`Storage account objetivo: ${EXPECTED_ENV.storageAccount}`);
  console.log('Containers (se vacían, no se borran):');
  let totalBlobs = 0;
  for (const { containerName, exists, count } of blobCounts) {
    console.log(`  ${containerName.padEnd(35)} ${exists ? `${count} blobs` : '(no existe)'}`);
    totalBlobs += count;
  }
  console.log(`  TOTAL: ${totalBlobs} blobs\n`);

  console.log(`Custom Vision endpoint objetivo: ${process.env.CUSTOM_VISION_ENDPOINT || '(no configurado)'}`);
  console.log(`Projects (se borran todos los existentes en este recurso — dedicado a esta app):`);
  if (cvProjects.length === 0) {
    console.log('  (ninguno — el recurso ya está vacío)');
  } else {
    cvProjects.forEach(p => console.log(`  ${p.id}  ${p.name}`));
  }
  console.log('');
}

function askConfirmation() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Para confirmar el borrado, tipeá exactamente: ${CONFIRM_PHRASE}\n> `, (answer) => {
      rl.close();
      resolve(answer === CONFIRM_PHRASE);
    });
  });
}

async function deleteTables() {
  const pool = await getPool();
  console.log('\n=== Borrando tablas (lista blanca) ===\n');
  for (const table of TABLES_WHITELIST) {
    await pool.request().query(`ALTER TABLE [${table}] NOCHECK CONSTRAINT ALL`);
  }
  for (const table of TABLES_WHITELIST) {
    try {
      const r = await pool.request().query(`DELETE FROM [${table}]`);
      console.log(`  ✓ ${table.padEnd(35)} ${r.rowsAffected?.[0] ?? 0} filas borradas`);
      // Reinicia identity si la tabla tiene una — no falla si no tiene.
      await pool.request().query(`
        IF OBJECTPROPERTY(OBJECT_ID('[${table}]'), 'TableHasIdentity') = 1
          DBCC CHECKIDENT ('[${table}]', RESEED, 0)
      `).catch(() => {});
    } catch (err) {
      console.error(`  ✗ ${table}: ${err.message}`);
    }
  }
  for (const table of TABLES_WHITELIST) {
    await pool.request().query(`ALTER TABLE [${table}] WITH CHECK CHECK CONSTRAINT ALL`).catch(() => {});
  }
}

async function deleteBlobs() {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    console.warn('\n[blobs] AZURE_STORAGE_CONNECTION_STRING no configurado — se omite.');
    return;
  }
  console.log('\n=== Vaciando containers (lista blanca) ===\n');
  const svc = BlobServiceClient.fromConnectionString(connStr);
  for (const containerName of CONTAINERS_WHITELIST) {
    const cc = svc.getContainerClient(containerName);
    if (!(await cc.exists())) {
      console.log(`  ${containerName}: no existe, nada que borrar.`);
      continue;
    }
    const names = [];
    for await (const blob of cc.listBlobsFlat()) names.push(blob.name);
    const CHUNK = 64;
    for (let i = 0; i < names.length; i += CHUNK) {
      const chunk = names.slice(i, i + CHUNK);
      await Promise.all(chunk.map(n => cc.deleteBlob(n).catch(() => {})));
    }
    console.log(`  ✓ ${containerName.padEnd(35)} ${names.length} blobs borrados`);
  }
}

async function deleteCvProjects() {
  if (!process.env.CUSTOM_VISION_TRAINING_KEY || !process.env.CUSTOM_VISION_ENDPOINT) {
    console.warn('\n[custom vision] no configurado — se omite.');
    return;
  }
  console.log('\n=== Borrando projects de Custom Vision ===\n');
  const projects = await listCvProjects();
  if (projects.length === 0) {
    console.log('  (ninguno)');
    return;
  }
  for (const p of projects) {
    await deleteCvProject(p.id);
    console.log(`  ✓ borrado: ${p.id}  ${p.name}`);
  }
}

(async () => {
  try {
    assertExpectedEnv();
    const inventory = await buildInventory();
    printInventory(inventory);

    const confirmed = await askConfirmation();
    if (!confirmed) {
      console.log('\nConfirmación no coincide — abortando. No se tocó nada.\n');
      process.exit(1);
    }

    await deleteTables();
    await deleteBlobs();
    await deleteCvProjects();

    console.log('\n=== Verificación post-borrado ===\n');
    const after = await buildInventory();
    printInventory(after);

    console.log('✅ Limpieza completada.\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error durante la limpieza:', err.message);
    process.exit(1);
  }
})();
