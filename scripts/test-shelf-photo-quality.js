// Script de pruebas del módulo de calidad de fotos de góndola (Issue 7.1).
// Llama a los módulos directamente (sin HTTP).
//
// Cubre:
//   Parte A — validador puro (sin BD): resolución, nitidez, brillo.
//   Parte B — servicio end-to-end (CON BD): inserta una foto y verifica que la
//             segunda vez se detecte como DUPLICATE_IMAGE. Limpia lo que inserta.
//
// Requisitos:
//   - .env configurado (SQL_*). La Parte B se conecta a la BD.
//   - Migración 005 aplicada (columnas image_hash, quality_*, width, height,
//     blur_score, brightness en RETSC_EX_SHELFPHOTO). Si no, la Parte B avisa.
//
// Correr:
//   node scripts/test-shelf-photo-quality.js
//
// NOTA: usa ENTERPRISE_ID de prueba (ver TEST_ENTERPRISE_ID) y borra su fila al final.

'use strict';

require('dotenv').config();

const sharp = require('sharp');
const { getPool, sql } = require('../src/config/db');
const { validateImageQuality } = require('../src/utils/imageQualityValidator');
const shelfPhotoQualityService = require('../src/services/shelfPhotoQualityService');

const TEST_ENTERPRISE_ID = 999999; // valor de prueba; se limpia al final

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ok(msg)   { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }
function log(msg)  { console.log(`  ${msg}`); }

// Imagen de ruido RGB en memoria: scale/offset controlan el rango de brillo.
// Ruido = alta frecuencia = nítida; .blur() la vuelve borrosa.
async function noise(w, h, scale = 255, offset = 0) {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = offset + Math.floor(Math.random() * scale);
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// ─── Parte A: validador puro (sin BD) ──────────────────────────────────────────
async function testValidator() {
  console.log('\n── Parte A: validador puro (resolución / nitidez / brillo) ──');

  const good   = await noise(1280, 720);
  const lowRes = await noise(640, 480);
  const dark   = await noise(1280, 720, 20, 0);
  const bright = await noise(1280, 720, 20, 235);
  const blurry = await sharp(await noise(1280, 720)).blur(15).png().toBuffer();

  const cases = [
    { name: 'foto buena 1280x720',  img: good,   valid: true,  code: null },
    { name: 'baja resolución',      img: lowRes, valid: false, code: 'LOW_RESOLUTION' },
    { name: 'oscura',               img: dark,   valid: false, code: 'POOR_LIGHTING' },
    { name: 'sobreexpuesta',        img: bright, valid: false, code: 'POOR_LIGHTING' },
    { name: 'borrosa',              img: blurry, valid: false, code: 'BLURRY_IMAGE' },
  ];

  for (const c of cases) {
    const r = await validateImageQuality(c.img);
    const m = r.metrics;
    const passed = r.valid === c.valid &&
      (c.code === null ? r.errors.length === 0 : r.errors.includes(c.code));
    const detail = `[${r.errors.join(',') || 'OK'}] ${m.width}x${m.height} bright=${m.brightness?.toFixed(1)} sharp=${m.sharpness?.toFixed(3)}`;
    if (passed) ok(`${c.name.padEnd(22)} → ${detail}`);
    else        fail(`${c.name.padEnd(22)} → esperaba valid=${c.valid}/${c.code}, obtuvo ${detail}`);
  }
}

// ─── Parte B: servicio + BD (dedup real) ───────────────────────────────────────
async function testServiceWithDb() {
  console.log('\n── Parte B: servicio end-to-end con BD (DUPLICATE_IMAGE) ──');

  const pool = await getPool();

  // Verifica que la migración 005 esté aplicada antes de seguir.
  const colCheck = await pool.request().query(`
    SELECT COUNT(*) AS n
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'RETSC_EX_SHELFPHOTO' AND COLUMN_NAME = 'image_hash'
  `);
  if (colCheck.recordset[0].n === 0) {
    fail('La columna image_hash no existe. Corré la migración 005 antes de esta parte.');
    return;
  }

  const img = await noise(1280, 720); // foto válida y única por run

  try {
    // 1ª vez: debe ser aceptada (aún no existe el hash para este enterprise)
    const first = await shelfPhotoQualityService.assessPhoto(img, { enterpriseId: TEST_ENTERPRISE_ID });
    if (first.accepted && first.qualityStatus === 'PASSED') ok(`1ª evaluación → aceptada (hash=${first.hash.slice(0, 12)}…)`);
    else fail(`1ª evaluación → esperaba aceptada, obtuvo errors=[${first.errors.join(',')}]`);

    // Simula la subida: insertamos la foto en la BD con su veredicto.
    await pool.request()
      .input('hash',  sql.VarChar(64), first.hash)
      .input('ent',   sql.Int,         TEST_ENTERPRISE_ID)
      .input('w',     sql.Int,         first.metrics.width)
      .input('h',     sql.Int,         first.metrics.height)
      .input('blur',  sql.Float,       first.metrics.sharpness)
      .input('brt',   sql.Float,       first.metrics.brightness)
      .query(`
        INSERT INTO RETSC_EX_SHELFPHOTO
          (ENTERPRISE_ID, image_hash, quality_status, width, height, blur_score, brightness)
        VALUES (@ent, @hash, 'PASSED', @w, @h, @blur, @brt)
      `);
    log('foto insertada en RETSC_EX_SHELFPHOTO (simulando la subida)');

    // 2ª vez: el mismo archivo ahora debe detectarse como duplicado.
    const second = await shelfPhotoQualityService.assessPhoto(img, { enterpriseId: TEST_ENTERPRISE_ID });
    if (!second.accepted && second.errorCode === 'DUPLICATE_IMAGE') ok('2ª evaluación → DUPLICATE_IMAGE (dedup por enterprise funciona)');
    else fail(`2ª evaluación → esperaba DUPLICATE_IMAGE, obtuvo errors=[${second.errors.join(',')}]`);

    // El mismo hash pero OTRO enterprise NO debe ser duplicado (scope por enterprise).
    const other = await shelfPhotoQualityService.assessPhoto(img, { enterpriseId: TEST_ENTERPRISE_ID + 1 });
    if (other.accepted) ok('mismo hash en otro enterprise → aceptada (scope por enterprise correcto)');
    else fail(`otro enterprise → esperaba aceptada, obtuvo errors=[${other.errors.join(',')}]`);
  } finally {
    // Limpieza: borra todo lo insertado por la prueba.
    const del = await pool.request()
      .input('ent', sql.Int, TEST_ENTERPRISE_ID)
      .query(`DELETE FROM RETSC_EX_SHELFPHOTO WHERE ENTERPRISE_ID = @ent`);
    log(`limpieza: ${del.rowsAffected[0]} fila(s) de prueba borrada(s)`);
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await testValidator();
    await testServiceWithDb();
  } catch (err) {
    console.error('\n❌ Error inesperado:', err.message);
    process.exitCode = 1;
  } finally {
    try { await sql.close(); } catch (_) {}
    console.log(`\n${process.exitCode ? '❌ Hubo fallos' : '✅ Todas las pruebas pasaron'}`);
    process.exit(process.exitCode || 0);
  }
})();
