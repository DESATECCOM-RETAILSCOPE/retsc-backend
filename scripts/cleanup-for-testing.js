// Script de limpieza total para pruebas.
// Borra TODAS las tablas excepto usuarios, empresas, roles y sus relaciones.
// También limpia todos los blobs de global-sku-training en Azure.
// DESTRUCTIVO e irreversible.

require('dotenv').config();
const { getPool }           = require('../src/config/db');
const { BlobServiceClient } = require('@azure/storage-blob');

// Tablas que NO se tocan
const KEEP = new Set([
  'RETSC_OP_USERS',
  'RETSC_OP_ENTERPRISE',
  'RETSC_OP_USRSXENTERP',
  'RETSC_OP_ROLES',
  'RETSC_INF_ACTIVATION_TOKENS',
]);

async function cleanDatabase() {
  console.log('\n=== Limpieza de base de datos ===\n');
  const pool = await getPool();

  // 1. Obtener todas las tablas del schema
  const tablesRes = await pool.request().query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `);
  const allTables   = tablesRes.recordset.map(r => r.TABLE_NAME);
  const toDelete    = allTables.filter(t => !KEEP.has(t));

  console.log(`  Tablas a limpiar : ${toDelete.length}`);
  console.log(`  Tablas protegidas: ${[...KEEP].join(', ')}\n`);

  // 2. Deshabilitar todas las FK constraints en las tablas a borrar
  //    (evita errores de orden de borrado)
  for (const table of toDelete) {
    await pool.request().query(`ALTER TABLE [${table}] NOCHECK CONSTRAINT ALL`);
  }
  console.log('  ✓ FK constraints deshabilitadas\n');

  // 3. Borrar en orden: primero tablas hoja (sin hijos en el scope), luego el resto.
  //    Como ya deshabilitamos FKs, cualquier orden funciona.
  const results = [];
  for (const table of toDelete) {
    try {
      const r = await pool.request().query(`DELETE FROM [${table}]`);
      const rows = r.rowsAffected?.[0] ?? 0;
      results.push({ table, rows, ok: true });
      console.log(`  ✓ ${table.padEnd(45)} ${rows} filas`);
    } catch (err) {
      results.push({ table, rows: 0, ok: false, error: err.message });
      console.error(`  ✗ ${table}: ${err.message}`);
    }
  }

  // 4. Re-habilitar FK constraints
  for (const table of toDelete) {
    try {
      await pool.request().query(`ALTER TABLE [${table}] WITH CHECK CHECK CONSTRAINT ALL`);
    } catch (_) {
      // Si hay datos huérfanos residuales en tablas que fallaron, ignorar.
    }
  }
  console.log('\n  ✓ FK constraints re-habilitadas');

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.warn(`\n  ⚠ ${failed.length} tabla(s) con error:`);
    failed.forEach(f => console.warn(`    - ${f.table}: ${f.error}`));
  }
}

async function cleanBlobs() {
  const connStr   = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const container = process.env.AZURE_GLOBAL_TRAINING_CONTAINER || 'global-sku-training';

  if (!connStr) {
    console.warn('\n[blobs] AZURE_STORAGE_CONNECTION_STRING no configurado — se omite limpieza de blobs.');
    return;
  }

  console.log(`\n=== Limpieza de blobs en "${container}" ===\n`);
  const containerClient = BlobServiceClient.fromConnectionString(connStr).getContainerClient(container);

  let count = 0;
  const batch = [];
  for await (const blob of containerClient.listBlobsFlat()) {
    batch.push(blob.name);
  }

  if (batch.length === 0) {
    console.log('  Container ya estaba vacío.');
    return;
  }

  // Borrar en paralelo en grupos de 64 para no saturar
  const CHUNK = 64;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK);
    await Promise.all(chunk.map(name => containerClient.deleteBlob(name).catch(() => {})));
    count += chunk.length;
    process.stdout.write(`\r  Eliminando blobs... ${count}/${batch.length}`);
  }
  console.log(`\n  ✓ ${count} blobs eliminados.`);
}

(async () => {
  try {
    await cleanDatabase();
    await cleanBlobs();
    console.log('\n✅ Limpieza completada. Base de datos y container en cero.\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error durante la limpieza:', err.message);
    process.exit(1);
  }
})();
