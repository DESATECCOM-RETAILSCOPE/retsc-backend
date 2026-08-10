// Pasos 1-5 del proceso de validación de OCR+embeddings (documento de María, "los técnicos,
// de Joel") — mide qué tan bien buscarSkuPorTexto identifica productos, reusando fotos de
// ENTRENAMIENTO ya anotadas (RETSC_AI_TRAINING_PHOTOS/RETSC_AI_TRAINING_ANNOTATIONS) como si
// fueran fotos de góndola, sin depender de un modelo CV publicado ni del pipeline de
// inferencia completo (que no existe todavía).
//
// Pasos que SÍ hace este script:
//   1. Trae fotos APROBADA + sus anotaciones (con --limit configurable).
//   2. Descarga la imagen original y recorta cada cajita según bbox_left/top/width/height
//      (normalizados 0-1, ver INFORMATION_SCHEMA — se multiplican por el ancho/alto real).
//   3. OCR del recorte vía visionOcrService.runOcr() — misma API/versión que usó la Function
//      para indexar (Image Analysis 4.0, features=read), así el texto es comparable.
//   4. Pasa el texto a skuSearchService.buscarSkuPorTexto() (reusada tal cual, NO reimplementada)
//      → sku_id_encontrado / similarity_score / matched.
//   5. Inserta en RETSC_TEST_OCR_EMBEDDING_VALIDATION con el annotation_id de origen.
//
// Pasos que NO hace (fuera de alcance a propósito):
//   6. Un humano llena sku_id_real después, a mano (columna ya existe, queda NULL acá).
//   7. Calcular el % de acierto — es un SELECT que corre alguien después de completar el 6.
//
// IDEMPOTENCIA: no hay constraint único en annotation_id (solo PK en validation_id) — este
// script borra la fila existente de esa anotación (si la hay) antes de insertar la nueva, así
// que re-correrlo no duplica filas. Si se re-corre después de que un humano ya completó
// sku_id_real para esa anotación, ese valor se PIERDE (el DELETE no distingue) — evitar
// re-correr sobre anotaciones que ya pasaron el Paso 6 sin confirmar con el equipo primero.
//
// USO:
//   node scripts/run-ocr-embedding-validation.js [--limit=100] [--dry-run]
//   --limit    máximo de anotaciones a procesar en esta corrida (default 100)
//   --dry-run  hace todo (descarga/recorte/OCR/búsqueda) pero NO inserta en la tabla —
//              para ver los resultados en consola sin tocar RETSC_TEST_OCR_EMBEDDING_VALIDATION

'use strict';

require('dotenv').config();

const sharp = require('sharp');
const { getPool, sql }       = require('../src/config/db');
const blobStorageService     = require('../src/services/blobStorageService');
const visionOcrService       = require('../src/services/visionOcrService');
const skuSearchService       = require('../src/services/skuSearchService');

const DEFAULT_LIMIT = 100;
const CONCURRENCY    = 5; // descarga+recorte+OCR por anotación — acotado para no saturar Vision

function getLimit() {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  const n = arg ? parseInt(arg.split('=')[1], 10) : DEFAULT_LIMIT;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

const DRY_RUN = process.argv.includes('--dry-run');

function shelfContainer() {
  return process.env.AZURE_GLOBAL_SHELF_CONTAINER || 'global-shelf-training';
}

// Trae hasta `limit` anotaciones de fotos APROBADA, con los datos de la foto ya unidos
// (blob_path) para no tener que resolverlo aparte por cada una.
async function fetchApprovedAnnotations(limit) {
  const pool = await getPool();
  const r = await pool.request()
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
        a.annotation_id, a.photo_id, a.bbox_left, a.bbox_top, a.bbox_width, a.bbox_height,
        p.blob_path
      FROM RETSC_AI_TRAINING_ANNOTATIONS a
      JOIN RETSC_AI_TRAINING_PHOTOS p ON p.photo_id = a.photo_id
      WHERE p.photo_status = 'APROBADA'
      ORDER BY a.annotation_id
    `);
  return r.recordset;
}

// Pool de concurrencia simple, mismo patrón ya usado en skuSearchService.js — sin
// dependencias nuevas.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Descarga la foto original UNA VEZ por photo_id (varias anotaciones pueden compartir foto),
// recorta según la bbox normalizada, y hace OCR del recorte. Nunca lanza — un fallo acá se
// captura y se reporta como { annotation_id, error } para no romper el resto de la corrida.
async function processAnnotation(row, imageBufferCache) {
  const { annotation_id, photo_id, blob_path, bbox_left, bbox_top, bbox_width, bbox_height } = row;

  try {
    let original = imageBufferCache.get(photo_id);
    if (!original) {
      original = await blobStorageService.downloadFromContainer({
        containerName: shelfContainer(),
        blobPath: blob_path,
      });
      imageBufferCache.set(photo_id, original);
    }

    const meta = await sharp(original).metadata();
    const left   = Math.max(0, Math.round(bbox_left   * meta.width));
    const top    = Math.max(0, Math.round(bbox_top    * meta.height));
    const width  = Math.max(1, Math.round(bbox_width  * meta.width));
    const height = Math.max(1, Math.round(bbox_height * meta.height));

    const crop = await sharp(original)
      .extract({ left, top, width, height })
      .jpeg()
      .toBuffer();

    const { text } = await visionOcrService.runOcr(crop);

    if (!text) {
      return { annotation_id, error: 'OCR_VACIO' };
    }

    return { annotation_id, ocr_text: text };
  } catch (err) {
    return { annotation_id, error: err.message.slice(0, 240) };
  }
}

// Borra (si existe) la fila previa de esta anotación e inserta la nueva — ver NOTA de
// cabecera sobre idempotencia y su límite (pisa un sku_id_real ya cargado por un humano).
async function upsertResult(row) {
  const pool = await getPool();
  await pool.request()
    .input('annotationId', sql.Int, row.annotation_id)
    .query('DELETE FROM RETSC_TEST_OCR_EMBEDDING_VALIDATION WHERE annotation_id = @annotationId');

  await pool.request()
    .input('annotationId', sql.Int, row.annotation_id)
    .input('ocrText',      sql.NVarChar(sql.MAX), row.ocr_text ?? null)
    .input('skuId',        sql.Int,   row.sku_id_encontrado ?? null)
    .input('score',        sql.Float, row.similarity_score ?? null)
    .input('matched',      sql.Bit,   row.matched ? 1 : 0)
    .input('notas',        sql.VarChar(250), row.notas ?? null)
    .query(`
      INSERT INTO RETSC_TEST_OCR_EMBEDDING_VALIDATION
        (annotation_id, ocr_text, sku_id_encontrado, similarity_score, matched, sku_id_real, notas, created_at)
      VALUES
        (@annotationId, @ocrText, @skuId, @score, @matched, NULL, @notas, GETDATE())
    `);
}

async function main() {
  const limit = getLimit();
  console.log(`=== Validación OCR+embeddings — límite=${limit}${DRY_RUN ? ' (DRY-RUN, no inserta)' : ''} ===`);

  const annotations = await fetchApprovedAnnotations(limit);
  console.log(`Anotaciones encontradas sobre fotos APROBADA: ${annotations.length}`);
  if (annotations.length === 0) {
    console.log('Nada que procesar — no hay anotaciones sobre fotos APROBADA todavía.');
    return;
  }

  console.log('--- Paso 2-3: descarga + recorte + OCR (concurrencia acotada) ---');
  const imageBufferCache = new Map();
  const ocrResults = await mapWithConcurrency(annotations, CONCURRENCY, row => processAnnotation(row, imageBufferCache));

  const ocrOk     = ocrResults.filter(r => r.ocr_text);
  const ocrFailed = ocrResults.filter(r => r.error);
  console.log(`OCR exitoso: ${ocrOk.length} | OCR fallido: ${ocrFailed.length}`);
  ocrFailed.forEach(r => console.log(`  [FALLO OCR] annotation_id=${r.annotation_id}: ${r.error}`));

  console.log('--- Paso 4: buscarSkuPorTexto (un solo batch para todos los OCR exitosos) ---');
  const searchResults = ocrOk.length ? await skuSearchService.buscarSkuPorTexto(ocrOk.map(r => r.ocr_text)) : [];

  const finalRows = [];
  ocrOk.forEach((r, i) => {
    const match = searchResults[i];
    finalRows.push({
      annotation_id:      r.annotation_id,
      ocr_text:           r.ocr_text,
      sku_id_encontrado:  match?.sku_id ?? null,
      similarity_score:   match?.similarity_score ?? null,
      matched:            match?.matched ?? false,
    });
  });
  ocrFailed.forEach(r => {
    finalRows.push({
      annotation_id:     r.annotation_id,
      ocr_text:          null,
      sku_id_encontrado: null,
      similarity_score:  null,
      matched:           false,
      notas:             `ERROR: ${r.error}`,
    });
  });

  console.log(`--- Paso 5: ${DRY_RUN ? 'mostrando' : 'insertando en RETSC_TEST_OCR_EMBEDDING_VALIDATION'} (${finalRows.length} filas) ---`);
  let inserted = 0, insertErrors = 0;
  for (const row of finalRows) {
    if (DRY_RUN) {
      console.log(`  annotation_id=${row.annotation_id} sku_id=${row.sku_id_encontrado} score=${row.similarity_score} matched=${row.matched}${row.notas ? ` notas=${row.notas}` : ''}`);
      continue;
    }
    try {
      await upsertResult(row);
      inserted++;
    } catch (err) {
      insertErrors++;
      console.error(`  [FALLO INSERT] annotation_id=${row.annotation_id}: ${err.message}`);
    }
  }

  console.log('=== Resumen ===');
  console.log(`  Anotaciones procesadas: ${annotations.length}`);
  console.log(`  OCR exitoso: ${ocrOk.length} | OCR fallido: ${ocrFailed.length}`);
  if (!DRY_RUN) console.log(`  Insertadas en BD: ${inserted} | Fallos de insert: ${insertErrors}`);
  console.log('  sku_id_real queda NULL para todas — lo completa un humano (Paso 6).');
  console.log('  % de acierto NO se calculó acá — es el Paso 7, corre después del Paso 6.');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Error inesperado:', err); process.exit(1); });
