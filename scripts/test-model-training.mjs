// Diagnóstico + prueba del entrenamiento de un modelo de detección de góndola.
//
// El endpoint manual de entrenamiento fue RETIRADO: hoy el único disparador real es
// annotationSyncService.checkAndUpdateThreshold(), que dispara startTraining() de forma
// automática cuando una categoría acumula >= SHELF_TRAINING_THRESHOLD (15) fotos SYNCED en
// algún canal. Este script permite (a) DIAGNOSTICAR por qué entrena o no, y (b) DISPARAR una
// prueba controlada.
//
// Uso (desde la raíz del repo, con .env apuntando a BD + Custom Vision reales):
//   node scripts/test-model-training.mjs <categoryId>            → solo diagnóstico (read-only)
//   node scripts/test-model-training.mjs <categoryId> --run      → camino REAL: checkAndUpdateThreshold
//                                                                   (solo entrena si hay >=15 SYNCED)
//   node scripts/test-model-training.mjs <categoryId> --force    → fuerza IMAGES_UPLOADED y llama
//                                                                   startTraining directo (prueba el
//                                                                   trainProject de CV aunque no haya
//                                                                   umbral; MUTA el status del modelo)
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('dotenv').config();
const aiModelRepo          = require(path.join(process.cwd(), 'src', 'repositories', 'aiModelRepo'));
const trainingPhotoRepo    = require(path.join(process.cwd(), 'src', 'repositories', 'trainingPhotoRepo'));
const customVisionService  = require(path.join(process.cwd(), 'src', 'services', 'customVisionService'));
const modelTrainingService = require(path.join(process.cwd(), 'src', 'services', 'modelTrainingService'));
const annotationSync       = require(path.join(process.cwd(), 'src', 'services', 'annotationSyncService'));

const CANALES   = ['OMT', 'DTT', 'CONVENIENCE'];
const THRESHOLD = parseInt(process.env.SHELF_TRAINING_THRESHOLD || '15', 10);
const CV_MIN_PER_TAG = 15; // mínimo de Custom Vision para entrenar detección: 15 imágenes por tag

const categoryId = parseInt(process.argv[2], 10);
const mode = process.argv.includes('--force') ? 'force' : process.argv.includes('--run') ? 'run' : 'diagnose';
if (!categoryId) { console.error('Falta <categoryId>. Ej: node scripts/test-model-training.mjs 6 --run'); process.exit(1); }

function line() { console.log('─'.repeat(72)); }

async function diagnose() {
  const model = await aiModelRepo.findByCategoryId(categoryId);
  if (!model) { console.error(`❌ No hay modelo para la categoría ${categoryId} (RETSC_AI_DETECTION_MODELS).`); process.exit(1); }

  line();
  console.log(`MODELO categoría=${categoryId}`);
  console.log(`  detection_model_id : ${model.detection_model_id}`);
  console.log(`  status             : ${model.status}`);
  console.log(`  project CV         : ${model.customvision_project_id || '(null — aún PENDING)'}`);
  console.log(`  prediction_res_id  : ${model.prediction_resource_id ? 'presente' : '(null — publicación fallará)'}`);
  console.log(`  model_version      : ${model.model_version}   is_active: ${model.is_active}`);
  console.log(`  trained_at         : ${model.trained_at ?? 'nunca'}`);
  if (model.last_training_error) console.log(`  last_training_error: ${model.last_training_error}`);
  console.log(`  Custom Vision cfg  : ${customVisionService.isConfigured() ? 'OK' : '❌ NO configurado (CUSTOM_VISION_ENDPOINT/KEY)'}`);

  // Conteo de fotos SYNCED por canal (lo que dispara el umbral automático).
  line();
  console.log(`FOTOS SYNCED por canal (desde trained_at=${model.trained_at ?? 'nunca'}) · umbral=${THRESHOLD}`);
  let algunCanalListo = false;
  for (const canal of CANALES) {
    const n = await trainingPhotoRepo.countSyncedSinceByCategoryChannel(categoryId, canal, model.trained_at ?? null);
    const ok = n >= THRESHOLD;
    if (ok) algunCanalListo = true;
    console.log(`  ${canal.padEnd(12)}: ${n}/${THRESHOLD} ${ok ? '✅' : ''}`);
  }

  // Tags en Custom Vision con su imageCount (precondición REAL de CV: >=15 imágenes por tag).
  line();
  console.log(`TAGS en Custom Vision (mínimo para entrenar detección: ${CV_MIN_PER_TAG} img/tag)`);
  let algunTagListo = false;
  if (customVisionService.isConfigured() && model.customvision_project_id) {
    try {
      const tags = await customVisionService.listTags(model.customvision_project_id);
      if (!tags.length) console.log('  (el proyecto no tiene tags — no hay regiones anotadas cargadas)');
      for (const t of tags) {
        const ok = (t.imageCount ?? 0) >= CV_MIN_PER_TAG;
        if (ok) algunTagListo = true;
        console.log(`  ${String(t.name).padEnd(20)}: ${t.imageCount ?? 0} img ${ok ? '✅' : '❌ (<15, CV rechazará el train)'}  id=${t.id}`);
      }
    } catch (err) {
      console.log(`  ⚠ no se pudieron listar tags: ${err.message}`);
    }
  } else {
    console.log('  (CV no configurado o modelo sin proyecto — no se puede consultar)');
  }

  // Veredicto.
  line();
  console.log('VEREDICTO');
  console.log(`  ¿algún canal con >=${THRESHOLD} SYNCED?  ${algunCanalListo ? 'SÍ ✅' : 'NO ❌ (el disparo automático no salta)'}`);
  console.log(`  ¿algún tag con >=${CV_MIN_PER_TAG} imágenes? ${algunTagListo ? 'SÍ ✅' : 'NO ❌ (CV dará "Not enough images per tag")'}`);
  console.log('  Recordá: subir fotos a CV NO alcanza — deben estar ANOTADAS (cajitas) y SYNCED,');
  console.log('  porque el entrenamiento de detección necesita regiones etiquetadas por tag.');
  line();
  return model;
}

async function pollUntilTerminal(modelId, maxMin = 21) {
  const TERMINAL = new Set(['TRAINED', 'PUBLISHED', 'TRAINING_FAILED']);
  const deadline = Date.now() + maxMin * 60_000;
  let last = null;
  console.log(`\n⏳ Observando el status en BD cada 15s (máx ${maxMin} min)…`);
  while (Date.now() < deadline) {
    const m = await aiModelRepo.findById(modelId);
    if (m.status !== last) {
      console.log(`  [${new Date().toISOString().slice(11, 19)}] status=${m.status}${m.last_training_error ? ` · error=${m.last_training_error}` : ''}`);
      last = m.status;
    }
    if (TERMINAL.has(m.status)) {
      console.log(`\n${m.status === 'TRAINING_FAILED' ? '❌' : '✅'} Terminal: ${m.status}`);
      return m;
    }
    await new Promise(r => setTimeout(r, 15_000));
  }
  console.log('\n⚠ Se agotó la espera del script (el training puede seguir del lado de CV).');
}

(async () => {
  try {
    const model = await diagnose();
    if (mode === 'diagnose') { console.log('\n(Modo diagnóstico. Agregá --run o --force para disparar.)'); process.exit(0); }

    if (mode === 'run') {
      console.log('\n▶ --run: llamando annotationSync.checkAndUpdateThreshold() (camino automático real)…');
      await annotationSync.checkAndUpdateThreshold(categoryId);
      // checkAndUpdateThreshold dispara startTraining fire-and-forget; observamos el modelo.
      await pollUntilTerminal(model.detection_model_id);
      process.exit(0);
    }

    if (mode === 'force') {
      console.log('\n▶ --force: seteo IMAGES_UPLOADED y llamo startTraining() directo (prueba el train de CV).');
      console.log('  ⚠ Esto MUTA el status del modelo. Si CV rechaza (p. ej. "Not enough images per tag"),');
      console.log('    el motivo real queda persistido en BD (migración 009).');
      await aiModelRepo.updateStatus(model.detection_model_id, 'IMAGES_UPLOADED');
      const res = await modelTrainingService.startTraining(categoryId, null);
      console.log(`  startTraining → ${JSON.stringify(res)}`);
      await pollUntilTerminal(res.modelId);
      process.exit(0);
    }
  } catch (err) {
    console.error(`\n❌ Falló: ${err.message}`);
    process.exit(1);
  }
})();
