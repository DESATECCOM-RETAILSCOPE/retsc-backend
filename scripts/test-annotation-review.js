// Script de pruebas del módulo de revisión de anotaciones (Issue 7.5).
// Llama a los servicios directamente (sin HTTP).
//
// Cubre:
//   Parte A — validación de bbox (sin BD): rangos normalizados [0,1].
//   Parte B — flujo end-to-end (CON BD): aprobar, corregir, readiness, rechazar y el
//             caso de borde "no se puede rechazar la última anotación". Limpia todo.
//
// Requisitos: .env configurado (SQL_*). La Parte B se conecta a la BD.
//
// Correr:
//   node scripts/test-annotation-review.js
//
// NOTA: inserta anotaciones de prueba y las borra al final (por annotation_id).

'use strict';

require('dotenv').config();

const { getPool, sql }    = require('../src/config/db');
const annotationService   = require('../src/services/annotationService');
const annotationRepo      = require('../src/repositories/annotationRepo');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ok(msg)   { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }
function log(msg)  { console.log(`  ${msg}`); }

async function expectThrow(fn, expectedStatus, label) {
  try {
    await fn();
    fail(`${label} → esperaba error ${expectedStatus} pero no lanzó`);
  } catch (err) {
    if (err.statusCode === expectedStatus) ok(`${label} → rechazado con ${expectedStatus} ("${err.message}")`);
    else fail(`${label} → esperaba ${expectedStatus}, obtuvo ${err.statusCode || 'sin status'} (${err.message})`);
  }
}

// Busca un id válido (tolerante a nombres de columna) para no romper FKs.
async function firstId(pool, table, pattern) {
  const r = await pool.request().query(`SELECT TOP 1 * FROM ${table}`);
  const row = r.recordset[0];
  if (!row) return null;
  const key = Object.keys(row).find((k) => pattern.test(k));
  return key ? row[key] : null;
}

// ─── Parte A: validación de bbox (sin BD) ──────────────────────────────────────
function testBboxValidation() {
  console.log('\n── Parte A: validación de coordenadas normalizadas [0,1] ──');

  const valid = { bbox_left: 0.1, bbox_top: 0.1, bbox_width: 0.5, bbox_height: 0.5 };
  try { annotationService.validateBbox(valid); ok('bbox válido aceptado'); }
  catch (e) { fail(`bbox válido rechazado: ${e.message}`); }

  const bad = [
    { name: 'left negativo',     box: { bbox_left: -0.1, bbox_top: 0.1, bbox_width: 0.2, bbox_height: 0.2 } },
    { name: 'width 0',           box: { bbox_left: 0.1, bbox_top: 0.1, bbox_width: 0, bbox_height: 0.2 } },
    { name: 'se sale del marco', box: { bbox_left: 0.8, bbox_top: 0.1, bbox_width: 0.5, bbox_height: 0.2 } },
    { name: 'no numérico',       box: { bbox_left: '0.1', bbox_top: 0.1, bbox_width: 0.2, bbox_height: 0.2 } },
  ];
  for (const c of bad) {
    try { annotationService.validateBbox(c.box); fail(`${c.name} → debió lanzar 400`); }
    catch (e) {
      if (e.statusCode === 400) ok(`${c.name} → 400`);
      else fail(`${c.name} → status inesperado ${e.statusCode}`);
    }
  }
}

// ─── Parte B: flujo end-to-end con BD ──────────────────────────────────────────
async function testReviewFlow() {
  console.log('\n── Parte B: aprobar / corregir / readiness / rechazar (con BD) ──');

  const pool = await getPool();
  const TABLE = 'RETSC_AI_TRAINING_ANNOTATIONS';

  // Reusa ids reales si existen para no romper FKs; si no, usa un valor de prueba.
  const reviewerId = await firstId(pool, 'RETSC_OP_USERS', /user.*id/i);
  const photoId    = (await firstId(pool, 'RETSC_EX_SHELFPHOTO', /^photo_id$/i)) ?? 999999;
  log(`usando photo_id=${photoId}, reviewer_id=${reviewerId ?? 'null'}`);

  const created = [];
  async function insertAnnotation() {
    const r = await pool.request()
      .input('photoId', sql.Int, photoId)
      .query(`
        INSERT INTO ${TABLE} (photo_id, bbox_left, bbox_top, bbox_width, bbox_height, source, is_validated, created_at)
        OUTPUT INSERTED.annotation_id
        VALUES (@photoId, 0.1, 0.1, 0.3, 0.3, 'TEST', 0, GETDATE())
      `);
    const id = r.recordset[0].annotation_id;
    created.push(id);
    return id;
  }

  try {
    const a1 = await insertAnnotation();
    const a2 = await insertAnnotation();
    log(`anotaciones de prueba creadas: ${a1}, ${a2}`);

    // APROBAR a1
    const approved = await annotationService.approve(a1, reviewerId);
    if (approved.is_validated === true || approved.is_validated === 1) ok('APROBAR → is_validated = 1');
    else fail(`APROBAR → is_validated quedó en ${approved.is_validated}`);
    if (!reviewerId || approved.photo_reviewer_id === reviewerId) ok('APROBAR → revisor registrado');
    else fail(`APROBAR → photo_reviewer_id=${approved.photo_reviewer_id}, esperaba ${reviewerId}`);

    // CORREGIR a2 (coords + validar)
    const corrected = await annotationService.correct(
      a2, { bbox_left: 0.2, bbox_top: 0.2, bbox_width: 0.4, bbox_height: 0.4 }, reviewerId,
    );
    const coordsOk = corrected.bbox_left === 0.2 && corrected.bbox_width === 0.4;
    if (coordsOk && (corrected.is_validated === true || corrected.is_validated === 1)) ok('CORREGIR → coords actualizadas + is_validated = 1');
    else fail(`CORREGIR → coords/is_validated inesperados (left=${corrected.bbox_left}, valid=${corrected.is_validated})`);

    // CORREGIR con bbox inválido → 400
    await expectThrow(
      () => annotationService.correct(a2, { bbox_left: 0.9, bbox_top: 0.1, bbox_width: 0.5, bbox_height: 0.2 }, reviewerId),
      400, 'CORREGIR con bbox fuera del marco',
    );

    // READINESS → 2 validadas, ready true
    const readiness = await annotationService.getPhotoReadiness(photoId);
    if (readiness.ready && readiness.validated >= 2) ok(`READINESS → ready=true, validadas=${readiness.validated}`);
    else fail(`READINESS → ${JSON.stringify(readiness)}`);

    // RECHAZAR a1 (quedan 2 → permitido)
    const rejected = await annotationService.reject(a1);
    if (rejected.deleted) { ok('RECHAZAR (no es la última) → eliminada'); created.splice(created.indexOf(a1), 1); }
    else fail('RECHAZAR → no eliminó');

    // RECHAZAR a2 (ahora es la última de la foto → bloqueado 409)
    await expectThrow(() => annotationService.reject(a2), 409, 'RECHAZAR la última anotación');

    // Anotación inexistente → 404
    await expectThrow(() => annotationService.approve(2000000001, reviewerId), 404, 'APROBAR id inexistente');
  } finally {
    // Limpieza: borra solo las anotaciones creadas por la prueba.
    for (const id of created) {
      await pool.request().input('id', sql.Int, id).query(`DELETE FROM ${TABLE} WHERE annotation_id = @id`);
    }
    log(`limpieza: ${created.length} anotación(es) de prueba borrada(s)`);
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    testBboxValidation();
    await testReviewFlow();
  } catch (err) {
    console.error('\n❌ Error inesperado:', err.message);
    process.exitCode = 1;
  } finally {
    try { await sql.close(); } catch (_) {}
    console.log(`\n${process.exitCode ? '❌ Hubo fallos' : '✅ Todas las pruebas pasaron'}`);
    process.exit(process.exitCode || 0);
  }
})();
