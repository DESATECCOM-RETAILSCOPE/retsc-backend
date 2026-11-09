/**
 * Ciclo 5 · A2 — Migración de tags de Custom Vision: canal → categoría
 * --------------------------------------------------------------------
 * Regla nueva: 1 proyecto CV = 1 categoría = 1 tag, y el tag es el nombre de la categoría
 * normalizado (toCvTagName: "Desodorantes Corporales" → "DESODORANTES_CORPORALES").
 * Los proyectos existentes tienen tags viejos: "OMT"/"DTT"/"CONVENIENCE" y compuestos
 * tipo "CATEGORIA OMT". Este script los lleva a la regla nueva.
 *
 * MODOS (sin flags = SOLO LECTURA):
 *   node scripts/a2-migrar-tags-categoria.js                 → diagnóstico (no cambia nada)
 *   node scripts/a2-migrar-tags-categoria.js --apply         → 1.3: renombra / mueve regiones
 *   node scripts/a2-migrar-tags-categoria.js --purge         → 1.4: borra tags viejos con 0 imágenes
 *   --category=<id>   limita a una categoría (recomendado para la primera corrida)
 *
 * QUÉ HACE --apply, por proyecto:
 *   1. Si NO existe el tag de la categoría y hay tags viejos con imágenes → RENOMBRA el que
 *      más imágenes tiene (PATCH tag). Conserva tagId, regiones y cv_region_id → la BD no cambia.
 *   2. Cada otro tag viejo con imágenes → MUEVE sus regiones al tag de la categoría:
 *      crea la región nueva (mismas coords), actualiza cv_region_id en
 *      RETSC_AI_TRAINING_ANNOTATIONS (viejo → nuevo) y recién después borra la región vieja.
 *      Si ya existe una región del tag nuevo con las mismas coords en esa imagen, la reutiliza.
 *   3. Los tags viejos que quedan en 0 imágenes se borran con --purge (paso aparte, 1.4).
 *
 * No toca el estado del modelo (RETSC_AI_DETECTION_MODELS): después de migrar, la categoría
 * necesita reentrenarse para que el modelo publicado prediga con el tag nuevo (Fase 3).
 */

require('dotenv').config();

const { getPool, sql }       = require('../src/config/db');
const customVisionService    = require('../src/services/customVisionService');
const { toCvTagName }        = require('../src/utils/categoryNameNormalizer');

const args       = process.argv.slice(2);
const APPLY      = args.includes('--apply');
const PURGE      = args.includes('--purge');
const catArg     = args.find(a => a.startsWith('--category='));
const ONLY_CAT   = catArg ? parseInt(catArg.split('=')[1], 10) : null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const EPS = 1e-6;
const sameCoords = (a, b) =>
  Math.abs(a.left - b.left) < EPS && Math.abs(a.top - b.top) < EPS &&
  Math.abs(a.width - b.width) < EPS && Math.abs(a.height - b.height) < EPS;

async function loadModels() {
  const pool = await getPool();
  const r = await pool.request()
    .input('cat', sql.Int, ONLY_CAT)
    .query(`
      SELECT m.detection_model_id, m.category_id, m.customvision_project_id, m.status,
             c.Category_dsc
      FROM   RETSC_AI_DETECTION_MODELS m
      JOIN   RETSC_OP_CATEGORIES c ON c.Category_id = m.category_id
      WHERE  m.is_active = 1
        AND  m.customvision_project_id IS NOT NULL
        AND  (@cat IS NULL OR m.category_id = @cat)
      ORDER  BY m.category_id`);
  return r.recordset;
}

async function getAllTaggedImages(projectId, tagId) {
  const out = [];
  for (let skip = 0; ; skip += 256) {
    const page = await customVisionService.getTaggedImages(projectId, tagId, { take: 256, skip });
    out.push(...page);
    if (page.length < 256) return out;
    await sleep(150);
  }
}

async function updateDbRegionId(oldId, newId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('oldId', sql.VarChar(100), oldId)
    .input('newId', sql.VarChar(100), newId)
    .query(`UPDATE RETSC_AI_TRAINING_ANNOTATIONS SET cv_region_id = @newId WHERE cv_region_id = @oldId`);
  return r.rowsAffected[0];
}

// Mueve todas las regiones de oldTag a targetTag, imagen por imagen.
async function moveRegions(projectId, oldTag, targetTag) {
  const images = await getAllTaggedImages(projectId, oldTag.id);
  let moved = 0, reused = 0, dbRows = 0, notInDb = 0;

  for (const img of images) {
    const oldRegions    = (img.regions ?? []).filter(r => r.tagId === oldTag.id);
    const targetRegions = (img.regions ?? []).filter(r => r.tagId === targetTag.id);
    if (!oldRegions.length) continue;

    // Pares viejo → nuevo. Si ya hay una región del tag destino con mismas coords, se reutiliza
    // (crearla de nuevo haría que Custom Vision rechace el lote con "Duplicate image regions").
    const pairs = [];
    const toCreate = [];
    const available = [...targetRegions];
    for (const r of oldRegions) {
      const idx = available.findIndex(t => sameCoords(t, r));
      if (idx >= 0) { pairs.push({ old: r, newId: available[idx].regionId }); available.splice(idx, 1); reused++; }
      else toCreate.push(r);
    }

    if (toCreate.length) {
      const created = await customVisionService.createImageRegions(projectId, toCreate.map(r => ({
        imageId: img.id, tagId: targetTag.id, left: r.left, top: r.top, width: r.width, height: r.height,
      })));
      const pool = [...created];
      for (const r of toCreate) {
        const idx = pool.findIndex(c => sameCoords(c, r));
        if (idx < 0) throw new Error(`imagen ${img.id}: no se pudo correlacionar la región creada para ${r.regionId} — se detiene sin borrar nada de esta imagen`);
        pairs.push({ old: r, newId: pool[idx].regionId });
        pool.splice(idx, 1);
        moved++;
      }
    }

    // BD primero, borrado en CV después: si algo falla a mitad, lo peor es una región duplicada
    // (con tag distinto) en CV, nunca una anotación apuntando a una región que ya no existe.
    for (const p of pairs) {
      const n = await updateDbRegionId(p.old.regionId, p.newId);
      if (n === 0) notInDb++; else dbRows += n;
    }
    await customVisionService.deleteImageRegions(projectId, pairs.map(p => p.old.regionId));
    await sleep(150);
  }
  return { images: images.length, moved, reused, dbRows, notInDb };
}

async function processModel(m) {
  const projectId = m.customvision_project_id;
  const target    = toCvTagName(m.Category_dsc);
  console.log(`\n\x1b[1mcategoría ${m.category_id} · ${m.Category_dsc}\x1b[0m  proyecto=${projectId}  status=${m.status}`);
  console.log(`  tag destino: ${target}`);

  let tags = await customVisionService.listTags(projectId);
  for (const t of tags) console.log(`  · tag "${t.name}"  imágenes=${t.imageCount}${t.name === target ? '  ← destino' : ''}`);

  let targetTag = tags.find(t => t.name === target);
  const oldNonEmpty = tags.filter(t => t.name !== target && t.imageCount > 0).sort((a, b) => b.imageCount - a.imageCount);
  const oldEmpty    = tags.filter(t => t.name !== target && t.imageCount === 0);

  // Plan
  const plan = [];
  let toMove = oldNonEmpty;
  if (!targetTag && oldNonEmpty.length) { plan.push(`RENOMBRAR "${oldNonEmpty[0].name}" → "${target}"`); toMove = oldNonEmpty.slice(1); }
  for (const t of toMove) plan.push(`MOVER regiones de "${t.name}" (${t.imageCount} imágenes) → "${target}"`);
  for (const t of oldEmpty) plan.push(`BORRAR tag vacío "${t.name}" (con --purge)`);
  if (!plan.length) plan.push('nada que hacer ✓');
  for (const p of plan) console.log(`  → ${p}`);

  if (APPLY) {
    if (!targetTag && oldNonEmpty.length) {
      targetTag = await customVisionService.updateTag(projectId, oldNonEmpty[0], target);
    }
    for (const t of toMove) {
      if (!targetTag) targetTag = await customVisionService.ensureTag(projectId, target);
      const r = await moveRegions(projectId, t, targetTag);
      console.log(`  ✓ "${t.name}": imágenes=${r.images} regiones movidas=${r.moved} reutilizadas=${r.reused} filas BD=${r.dbRows} regiones sin fila en BD=${r.notInDb}`);
    }
  }

  if (PURGE) {
    tags = await customVisionService.listTags(projectId);
    for (const t of tags.filter(t => t.name !== target)) {
      if (t.imageCount === 0) { await customVisionService.deleteTag(projectId, t.id); console.log(`  ✓ tag vacío "${t.name}" borrado`); }
      else console.log(`  ! tag "${t.name}" todavía tiene ${t.imageCount} imágenes — NO se borra (correr --apply primero)`);
    }
  }
}

(async () => {
  const mode = APPLY && PURGE ? 'APPLY + PURGE' : APPLY ? 'APPLY (1.3)' : PURGE ? 'PURGE (1.4)' : 'DIAGNÓSTICO (solo lectura)';
  console.log(`\x1b[1m\x1b[35mA2 · migración de tags  —  modo: ${mode}\x1b[0m`);
  console.log(`BD: ${process.env.SQL_SERVER} / ${process.env.SQL_DATABASE}`);
  console.log(`Custom Vision: ${process.env.CUSTOM_VISION_ENDPOINT}`);
  if (ONLY_CAT) console.log(`Solo categoría: ${ONLY_CAT}`);

  if (!customVisionService.isConfigured()) throw new Error('Custom Vision no configurado en el .env');

  const models = await loadModels();
  if (!models.length) console.log('\nNo hay modelos activos con proyecto de Custom Vision.');
  for (const m of models) {
    try { await processModel(m); }
    catch (err) { console.error(`  \x1b[31m✗ categoría ${m.category_id}: ${err.message}\x1b[0m`); process.exitCode = 1; }
  }
  if (!APPLY && !PURGE) console.log('\nModo diagnóstico: no se cambió nada. Ver plan arriba.');
  process.exit();
})().catch(err => { console.error(err); process.exit(1); });
