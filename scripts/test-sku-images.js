// Script de pruebas de integración para el módulo de imágenes de SKU.
// Llama a los servicios directamente (sin HTTP) para evitar dependencias de form-data.
//
// Tests cubiertos:
//   Test 1  (re-run): batch mixto → processed:2, orphans:1, duplicates:1
//   Test 9:  huérfana → blob en huerfanas/, log ORPHAN, nada en SKU_FEATURES
//   Test 10: adopción retroactiva → SKU_FEATURES + metadata + log ADOPTED
//   Test 11: respuesta muestra orphans:N, no rejected

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const { getPool, sql }    = require('../src/config/db');
const authService         = require('../src/services/authService');
const skuImageService     = require('../src/services/skuImageService');

// ─── EANs de prueba ──────────────────────────────────────────────────────────
const EAN_SMART   = '7501031311309'; // SKU_ID=1, categoría SHAMPOO (smart)
const EAN_NOSMART = '7501031311316'; // SKU_ID=2, categoría no-smart
// EAN que NO existe en RETSC_OP_SKUS (huérfana)
// EAN-13 con checksum válido que seguramente no existe
const EAN_ORPHAN  = '4006381333931';

// ─── Helpers ────────────────────────────────────────────────────────────────

function ok(msg)   { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }
function log(msg)  { console.log(`  ${msg}`); }

// PNG mínimo 1×1 válido
const PNG_BUF = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
  '2e000000000c4944415408d76360f8cfc00000000200016e21bc330000000049454e44ae426082',
  'hex'
);

const TMP_DIR = path.join(__dirname, '../uploads-temp/test-sku-imgs');

function makeTmpFile(name) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, PNG_BUF);
  return p;
}

// Crea objeto "file" compatible con lo que espera processBatch (multer shape)
function fakeFile(ean, view, ext) {
  ext = ext || 'png';
  const name = `${ean}_${view}.${ext}`;
  const p    = makeTmpFile(name);
  return { originalname: name, path: p, size: PNG_BUF.length };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanupTestData(pool) {
  await pool.request()
    .input('e1', sql.VarChar(20), EAN_SMART)
    .input('e2', sql.VarChar(20), EAN_NOSMART)
    .input('e3', sql.VarChar(20), EAN_ORPHAN)
    .query(`DELETE FROM RETSC_LOG_IMAGE_UPLOAD WHERE ean IN (@e1, @e2, @e3)`);

  // Primero metadata, luego features (FK)
  await pool.request().query(`
    DELETE FROM RETSC_AI_SKU_IMAGE_METADATA
    WHERE feature_id IN (SELECT feature_id FROM RETSC_AI_SKU_FEATURES WHERE sku_id IN (1,2))
  `);
  await pool.request().query(`DELETE FROM RETSC_AI_SKU_FEATURES WHERE sku_id IN (1,2)`);
  await pool.request().query(`UPDATE RETSC_OP_SKUS SET image_url=NULL, has_visual_variant=NULL WHERE SKU_ID IN (1,2)`);
}

function cleanMockBlobs() {
  const root = path.join(__dirname, '../data/blob-mock/global-sku-training');
  for (const prefix of ['dtc-shampoo', 'sin-categoria-smart', 'huerfanas']) {
    const dir = path.join(root, prefix);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(EAN_SMART) || f.startsWith(EAN_NOSMART) || f.startsWith(EAN_ORPHAN)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  }
}

// ─── Obtener token para los logs (no requerido en prueba directa) ─────────────

async function getFakeAuth(pool) {
  const r = await pool.request().query(`
    SELECT TOP 1 u.User_id, u.email, ue.Enterprise_id, ue.Role_id, ro.Role_name
    FROM RETSC_OP_USERS u
    JOIN RETSC_OP_USRSXENTERP ue ON ue.User_id = u.User_id
    JOIN RETSC_OP_ROLES ro ON ro.Role_id = ue.Role_id
    WHERE u.Status = 1 AND ue.Status = 1
    ORDER BY u.User_id ASC
  `);
  const row = r.recordset[0];
  if (!row) throw new Error('No hay usuarios activos en la DB');
  return { enterpriseId: row.Enterprise_id, userId: row.User_id };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== Tests: módulo imágenes SKU (Pasada 2 — gaps cerrados) ===\n');

  const pool = await getPool();

  log('Limpiando datos anteriores...');
  await cleanupTestData(pool);
  cleanMockBlobs();
  log('Cleanup OK\n');

  const { enterpriseId, userId } = await getFakeAuth(pool);
  log(`Auth: enterpriseId=${enterpriseId}, userId=${userId}\n`);

  // ── Test 1/11: batch mixto (smart + no-smart + huérfana) ──────────────────
  console.log('--- Test 1/11: batch mixto ---');
  {
    const files = [
      fakeFile(EAN_SMART,   'front'),
      fakeFile(EAN_NOSMART, 'front'),
      fakeFile(EAN_ORPHAN,  'front'),
    ];

    const result = await skuImageService.processBatch({ files, uploadedBy: userId, enterpriseId });

    log(`Resultado: ${JSON.stringify({ processed: result.processed, orphans: result.orphans, duplicates: result.duplicates, errors: result.errors })}`);

    if (result.processed !== 2) fail(`processed esperado 2, recibido ${result.processed}`);
    else ok(`processed=2`);

    if (result.orphans !== 1) fail(`orphans esperado 1, recibido ${result.orphans}`);
    else ok(`orphans=1`);

    // Test 11: no debe haber campo 'rejected'
    if ('rejected' in result) fail(`no debe haber campo 'rejected' en la respuesta`);
    else ok(`Test 11: sin campo 'rejected' ✓`);

    if (result.errors.length > 0) fail(`errors inesperados: ${JSON.stringify(result.errors)}`);
    else ok(`sin errores`);
  }

  // ── Test 1b: duplicado ────────────────────────────────────────────────────
  console.log('\n--- Test 1b: duplicado ---');
  {
    const files = [ fakeFile(EAN_SMART, 'front') ];
    const result = await skuImageService.processBatch({ files, uploadedBy: userId, enterpriseId });
    if (result.duplicates !== 1) fail(`duplicates esperado 1, recibido ${result.duplicates}`);
    else ok(`duplicates=1`);
  }

  // ── Test 9: verificar DB + blob ────────────────────────────────────────────
  console.log('\n--- Test 9: huérfana en log + blob + ausente en SKU_FEATURES ---');
  {
    const logRow = await pool.request()
      .input('ean', sql.VarChar(20), EAN_ORPHAN)
      .query(`SELECT TOP 1 * FROM RETSC_LOG_IMAGE_UPLOAD WHERE ean = @ean AND process_status = 'ORPHAN'`);

    if (logRow.recordset.length === 0) {
      fail(`No hay fila en RETSC_LOG_IMAGE_UPLOAD con process_status='ORPHAN' para EAN ${EAN_ORPHAN}`);
    } else {
      const row = logRow.recordset[0];
      ok(`Log ORPHAN: image_log_id=${row.image_log_id}, image_status=${row.image_status}`);

      if (row.image_status !== 'PENDING_MATCH')
        fail(`image_status esperado PENDING_MATCH, recibido ${row.image_status}`);
      else
        ok(`image_status=PENDING_MATCH`);

      if (!row.image_url || !row.image_url.includes('huerfanas'))
        fail(`image_url debería contener 'huerfanas': ${row.image_url}`);
      else
        ok(`image_url → huerfanas/`);

      // No debe estar en SKU_FEATURES: verificar por image_url exacta (no por hash,
      // ya que todos los archivos de test usan el mismo PNG → mismo hash)
      const feat = await pool.request()
        .input('url', sql.VarChar(1000), row.image_url)
        .query(`SELECT COUNT(*) AS cnt FROM RETSC_AI_SKU_FEATURES WHERE image_url = @url`);
      if (feat.recordset[0].cnt > 0)
        fail(`La huérfana NO debería estar en RETSC_AI_SKU_FEATURES`);
      else
        ok(`Huérfana ausente en RETSC_AI_SKU_FEATURES`);
    }

    // Verificar blob: en modo azure la URL es la de Azure; en modo mock es local.
    // Se verifica que image_url esté poblada y apunte a 'huerfanas/' (ya se chequeó arriba).
    // Si está en mock, también se verifica el archivo local.
    const mockBlobPath = path.join(
      __dirname, '../data/blob-mock/global-sku-training/huerfanas',
      `${EAN_ORPHAN}_front.png`
    );
    if (process.env.BLOB_STORAGE_MODE === 'mock' || !process.env.BLOB_STORAGE_MODE) {
      if (fs.existsSync(mockBlobPath))
        ok(`Blob mock OK: huerfanas/${EAN_ORPHAN}_front.png`);
      else
        fail(`Blob mock no encontrado: ${mockBlobPath}`);
    } else {
      ok(`Blob en Azure: imagen subida a URL de Azure (modo=${process.env.BLOB_STORAGE_MODE})`);
    }
  }

  // ── Test 10: adopción retroactiva ─────────────────────────────────────────
  console.log('\n--- Test 10: adopción retroactiva ---');
  let testSkuId = null;
  {
    const prod = await pool.request().query(`SELECT TOP 1 product_id FROM RETSC_OP_PRODUCTS`);
    const productId = prod.recordset[0]?.product_id;
    if (!productId) { fail('No hay productos en la DB'); return; }

    // Insertar SKU de prueba con el EAN huérfano
    const ins = await pool.request()
      .input('ean',       sql.VarChar(18), EAN_ORPHAN)
      .input('productId', sql.Int,         productId)
      .query(`INSERT INTO RETSC_OP_SKUS (EAN, product_id) OUTPUT INSERTED.SKU_ID VALUES (@ean, @productId)`);
    testSkuId = ins.recordset[0]?.SKU_ID;
    log(`SKU de prueba: SKU_ID=${testSkuId}`);

    // Llamar adopción
    const adopted = await skuImageService.resolveOrphansForSku(testSkuId, EAN_ORPHAN);
    if (adopted < 1) fail(`resolveOrphansForSku esperaba ≥1, devolvió ${adopted}`);
    else ok(`resolveOrphansForSku: adopted=${adopted}`);

    // Verificar en SKU_FEATURES
    const feat = await pool.request()
      .input('skuId', sql.Int, testSkuId)
      .query(`SELECT * FROM RETSC_AI_SKU_FEATURES WHERE sku_id = @skuId`);
    if (feat.recordset.length === 0)
      fail(`No se insertó en RETSC_AI_SKU_FEATURES`);
    else
      ok(`SKU_FEATURES: feature_id=${feat.recordset[0].feature_id}, is_primary=${feat.recordset[0].is_primary}`);

    // Verificar metadata
    if (feat.recordset.length > 0) {
      const fid  = feat.recordset[0].feature_id;
      const meta = await pool.request()
        .input('fid', sql.Int, fid)
        .query(`SELECT metadata_key, metadata_value FROM RETSC_AI_SKU_IMAGE_METADATA WHERE feature_id = @fid`);
      const keys = meta.recordset.map(r => r.metadata_key);
      ok(`Metadata keys: ${keys.join(', ')}`);

      if (!keys.includes('generated_filename'))
        fail(`Falta 'generated_filename' en metadata`);
      else {
        const gf = meta.recordset.find(r => r.metadata_key === 'generated_filename');
        ok(`generated_filename='${gf.metadata_value}'`);
      }
      if (!keys.includes('perspective'))
        fail(`Falta 'perspective' en metadata`);
      else
        ok(`perspective OK`);
    }

    // Verificar log ADOPTED
    const logRow = await pool.request()
      .input('ean', sql.VarChar(20), EAN_ORPHAN)
      .query(`SELECT TOP 1 * FROM RETSC_LOG_IMAGE_UPLOAD WHERE ean = @ean ORDER BY created_at DESC`);
    const row = logRow.recordset[0];
    if (!row)
      fail(`No se encontró fila en log`);
    else if (row.process_status !== 'ADOPTED')
      fail(`process_status esperado ADOPTED, recibido ${row.process_status}`);
    else
      ok(`Log ADOPTED: sku_id=${row.sku_id}`);
  }

  // ── Test 9b: generated_filename en features normales (Gap 4) ─────────────
  console.log('\n--- Test 9b: generated_filename en metadata de SKU normal ---');
  {
    const feat = await pool.request()
      .query(`SELECT TOP 1 feature_id FROM RETSC_AI_SKU_FEATURES WHERE sku_id = 1`);
    if (feat.recordset.length > 0) {
      const fid  = feat.recordset[0].feature_id;
      const meta = await pool.request()
        .input('fid', sql.Int, fid)
        .query(`SELECT metadata_key, metadata_value FROM RETSC_AI_SKU_IMAGE_METADATA WHERE feature_id = @fid AND metadata_key = 'generated_filename'`);
      if (meta.recordset.length === 0)
        fail(`No se encontró generated_filename en metadata de SKU_ID=1`);
      else
        ok(`Gap 4: generated_filename='${meta.recordset[0].metadata_value}'`);
    }
  }

  // ── Limpieza del SKU de prueba ─────────────────────────────────────────────
  if (testSkuId) {
    const feat = await pool.request()
      .input('s', sql.Int, testSkuId)
      .query(`SELECT feature_id FROM RETSC_AI_SKU_FEATURES WHERE sku_id = @s`);
    for (const f of feat.recordset) {
      await pool.request().input('fid', sql.Int, f.feature_id)
        .query(`DELETE FROM RETSC_AI_SKU_IMAGE_METADATA WHERE feature_id = @fid`).catch(()=>{});
    }
    await pool.request().input('s', sql.Int, testSkuId)
      .query(`DELETE FROM RETSC_AI_SKU_FEATURES WHERE sku_id = @s`).catch(()=>{});
    await pool.request().input('s', sql.Int, testSkuId)
      .query(`DELETE FROM RETSC_OP_SKUS WHERE SKU_ID = @s`).catch(()=>{});
    log(`\n(SKU de prueba SKU_ID=${testSkuId} eliminado)`);
  }

  // Limpiar directorio tmp
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  console.log('\n=== Tests completados ===\n');
  await pool.close();
}

runTests().catch(err => {
  console.error('\n💥 Error inesperado:', err.message, err.stack);
  process.exit(1);
});
