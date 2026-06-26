// Script de pruebas del módulo de versioning y re-entrenamiento (Issue 8.5).
// Llama a los servicios directamente (sin HTTP).
//
// Cubre:
//   Parte A — lógica de comparación de métricas (sin BD).
//   Parte B — flujo end-to-end (CON BD): regla de 20 fotos, versión peor →
//             AWAITING_APPROVAL, aprobación, activación automática (mejor) y rollback.
//             Usa categorías de prueba (999999/999998) y limpia todo al final.
//
// Requisitos: .env configurado y migración 006 aplicada (columna mean_ap). Si falta,
// la Parte B avisa y no rompe.
//
// Correr:
//   node scripts/test-model-versioning.js

'use strict';

require('dotenv').config();

const { getPool, sql }       = require('../src/config/db');
const aiModelRepo            = require('../src/repositories/aiModelRepo');
const modelVersioningService = require('../src/services/modelVersioningService');

const CAT_OK    = 999999; // categoría de prueba con fotos suficientes
const CAT_BLOCK = 999998; // categoría de prueba sin fotos nuevas

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ok(msg)   { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }
function log(msg)  { console.log(`  ${msg}`); }
const truthy = (v) => v === true || v === 1;

async function expectThrow(fn, status, label) {
  try { await fn(); fail(`${label} → esperaba ${status}, no lanzó`); }
  catch (e) {
    if (e.statusCode === status) ok(`${label} → ${status} ("${e.message}")`);
    else fail(`${label} → esperaba ${status}, obtuvo ${e.statusCode || 'sin status'} (${e.message})`);
  }
}

// ─── Parte A: comparación de métricas (sin BD) ─────────────────────────────────
function testMetricLogic() {
  console.log('\n── Parte A: lógica isWorse (mAP) ──');
  const { isWorse } = modelVersioningService;
  const cases = [
    { a: 0.6, b: 0.8, worse: true,  name: 'nueva peor' },
    { a: 0.9, b: 0.8, worse: false, name: 'nueva mejor' },
    { a: 0.8, b: 0.8, worse: false, name: 'iguales' },
    { a: 0.7, b: null, worse: false, name: 'sin baseline' },
  ];
  for (const c of cases) {
    const r = isWorse(c.a, c.b);
    if (r === c.worse) ok(`${c.name} (mAP ${c.a} vs ${c.b}) → worse=${r}`);
    else fail(`${c.name} → esperaba worse=${c.worse}, obtuvo ${r}`);
  }
}

// ─── Parte B: flujo con BD ─────────────────────────────────────────────────────
async function testLifecycle() {
  console.log('\n── Parte B: versioning end-to-end (con BD) ──');
  const pool = await getPool();

  // Verifica migración 006
  const col = await pool.request().query(`
    SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'RETSC_AI_DETECTION_MODELS' AND COLUMN_NAME = 'mean_ap'
  `);
  if (col.recordset[0].n === 0) {
    fail('La columna mean_ap no existe. Corré la migración 006 antes de esta parte.');
    return;
  }

  async function cleanup() {
    await pool.request().query(`DELETE FROM RETSC_AI_DETECTION_MODELS WHERE category_id IN (${CAT_OK}, ${CAT_BLOCK})`);
    await pool.request().query(`DELETE FROM RETSC_AI_TRAINING_ANNOTATIONS WHERE dtc_category_id IN (${CAT_OK}, ${CAT_BLOCK})`);
  }

  // Inserta N anotaciones validadas con created_at en el futuro (cuentan como "nuevas").
  async function seedValidatedPhotos(categoryId, n) {
    for (let i = 1; i <= n; i++) {
      await pool.request()
        .input('cat', sql.Int, categoryId)
        .input('photo', sql.Int, i)
        .query(`
          INSERT INTO RETSC_AI_TRAINING_ANNOTATIONS
            (photo_id, dtc_category_id, bbox_left, bbox_top, bbox_width, bbox_height, source, is_validated, created_at)
          VALUES (@photo, @cat, 0.1, 0.1, 0.3, 0.3, 'TEST', 1, DATEADD(MINUTE, 1, GETDATE()))
        `);
    }
  }

  try {
    await cleanup(); // estado limpio por si quedó algo de una corrida previa

    // ── Setup CAT_OK: v1 activa con mAP 0.8 y 25 fotos nuevas ──
    const v1 = await aiModelRepo.insert({ categoryId: CAT_OK, modelName: 'test-modelo', modelVersion: 1, status: 'READY', isActive: 1 });
    await aiModelRepo.saveMetrics(v1.detection_model_id, { meanAp: 0.8, precisionScore: 0.8, recallScore: 0.8 });
    await aiModelRepo.setActiveVersion(CAT_OK, v1.detection_model_id);
    await seedValidatedPhotos(CAT_OK, 25);
    log('setup CAT_OK: v1 activa (mAP=0.8), 25 fotos validadas nuevas');

    // canRetrain → true
    const check = await modelVersioningService.canRetrain(CAT_OK);
    if (check.canRetrain && check.newPhotos >= 20) ok(`canRetrain → true (${check.newPhotos} fotos nuevas, req ${check.required})`);
    else fail(`canRetrain → ${JSON.stringify(check)}`);

    // startRetrain → v2 TRAINING inactiva
    const v2 = await modelVersioningService.startRetrain(CAT_OK);
    if (v2.model_version === 2 && v2.status === 'TRAINING' && !truthy(v2.is_active)) ok('startRetrain → v2 TRAINING (inactiva)');
    else fail(`startRetrain → version=${v2.model_version}, status=${v2.status}, active=${v2.is_active}`);

    // completeRetrain con mAP peor → AWAITING_APPROVAL, v1 sigue activa
    const worse = await modelVersioningService.completeRetrain(v2.detection_model_id, { meanAp: 0.6, precision: 0.6, recall: 0.6 });
    const activeAfterWorse = await aiModelRepo.findByCategoryId(CAT_OK);
    if (worse.decision === 'AWAITING_APPROVAL' && activeAfterWorse.model_version === 1) ok('completeRetrain (peor) → AWAITING_APPROVAL, v1 sigue activa');
    else fail(`completeRetrain peor → decision=${worse.decision}, activa=v${activeAfterWorse.model_version}`);

    // approveVersion → v2 activa
    await modelVersioningService.approveVersion(v2.detection_model_id, 1);
    const activeAfterApprove = await aiModelRepo.findByCategoryId(CAT_OK);
    if (activeAfterApprove.model_version === 2) ok('approveVersion → v2 activa');
    else fail(`approveVersion → activa=v${activeAfterApprove.model_version}`);

    // rollback a v1 → v1 activa
    await modelVersioningService.rollback(CAT_OK, 1);
    const activeAfterRollback = await aiModelRepo.findByCategoryId(CAT_OK);
    if (activeAfterRollback.model_version === 1) ok('rollback(v1) → v1 activa');
    else fail(`rollback → activa=v${activeAfterRollback.model_version}`);

    // startRetrain de nuevo → v3; completeRetrain mejor → activación automática
    const v3 = await modelVersioningService.startRetrain(CAT_OK);
    const better = await modelVersioningService.completeRetrain(v3.detection_model_id, { meanAp: 0.9, precision: 0.9, recall: 0.9 });
    const activeAfterBetter = await aiModelRepo.findByCategoryId(CAT_OK);
    if (better.decision === 'ACTIVATED' && activeAfterBetter.model_version === v3.model_version) ok(`completeRetrain (mejor) → activación automática (v${v3.model_version})`);
    else fail(`completeRetrain mejor → decision=${better.decision}, activa=v${activeAfterBetter.model_version}`);

    // ── CAT_BLOCK: v1 activa sin fotos nuevas → no se puede re-entrenar ──
    const b1 = await aiModelRepo.insert({ categoryId: CAT_BLOCK, modelName: 'test-bloqueo', modelVersion: 1, status: 'READY', isActive: 1 });
    await aiModelRepo.saveMetrics(b1.detection_model_id, { meanAp: 0.8 });
    await aiModelRepo.setActiveVersion(CAT_BLOCK, b1.detection_model_id);
    const checkBlock = await modelVersioningService.canRetrain(CAT_BLOCK);
    if (!checkBlock.canRetrain) ok(`canRetrain(sin fotos) → false (${checkBlock.newPhotos} nuevas)`);
    else fail(`canRetrain bloqueo → ${JSON.stringify(checkBlock)}`);
    await expectThrow(() => modelVersioningService.startRetrain(CAT_BLOCK), 409, 'startRetrain sin fotos suficientes');

    // Modelo inexistente → 404
    await expectThrow(() => modelVersioningService.completeRetrain(2000000001, { meanAp: 0.5 }), 404, 'completeRetrain id inexistente');
  } finally {
    await cleanup();
    log('limpieza: modelos y anotaciones de prueba borrados');
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    testMetricLogic();
    await testLifecycle();
  } catch (err) {
    console.error('\n❌ Error inesperado:', err.message);
    process.exitCode = 1;
  } finally {
    try { await sql.close(); } catch (_) {}
    console.log(`\n${process.exitCode ? '❌ Hubo fallos' : '✅ Todas las pruebas pasaron'}`);
    process.exit(process.exitCode || 0);
  }
})();
