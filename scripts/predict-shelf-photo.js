// Corre una predicción manual de UNA foto contra el modelo YA PUBLICADO de una categoría.
//
// Caso de uso: una foto real de visita (container "enterprise-shelf-visits" — vive en Azure
// Blob Storage, este backend no lo referencia en ningún otro lugar del código ni del .env,
// no forma parte de ningún pipeline de entrenamiento/anotación documentado en CLAUDE.md) que
// alguien quiere probar contra el detector ya publicado, sin construir un endpoint HTTP nuevo
// ni tocar RETSC_EX_SHELFPHOTO_DETECTION (esa tabla existe pero nada la escribe todavía — un
// pipeline de inferencia real es un proyecto aparte, esto es solo una prueba puntual).
//
// Qué hace:
//   1. Descarga el blob (blobStorageService.downloadFromContainer — ya soporta cualquier
//      container por nombre, no solo los configurados por env var).
//   2. Busca el modelo activo de la categoría (aiModelRepo.findByCategoryId) y exige que esté
//      PUBLISHED — si no, no hay iteración publicada contra la cual predecir.
//   3. Llama a customVisionService.predictImage() (Prediction API v3.0 — distinta de la
//      Training API que usa el resto del repo; requiere CUSTOM_VISION_PREDICTION_KEY, ya
//      declarada en .env/.env.example pero sin ningún consumidor hasta ahora).
//   4. Imprime las predicciones (tag, probabilidad, bounding box) ordenadas de mayor a menor.
//
// No persiste nada en SQL — es de solo lectura/consulta contra Custom Vision.
//
// USO:
//   node scripts/predict-shelf-photo.js --categoryId=2 --blobPath=<ruta-dentro-del-container>
//   --container=enterprise-shelf-visits   (opcional, default enterprise-shelf-visits)
//   --minProbability=0.3                  (opcional, default 0.3 — filtra el ruido de salida)

'use strict';

require('dotenv').config();

const aiModelRepo = require('../src/repositories/aiModelRepo');
const blobStorageService = require('../src/services/blobStorageService');
const customVisionService = require('../src/services/customVisionService');

function parseArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const categoryId = Number(args.categoryId);
  const blobPath = args.blobPath;
  const containerName = args.container || 'enterprise-shelf-visits';
  const minProbability = args.minProbability !== undefined ? Number(args.minProbability) : 0.3;

  if (!categoryId || !blobPath) {
    console.error('Uso: node scripts/predict-shelf-photo.js --categoryId=<id> --blobPath=<ruta> [--container=enterprise-shelf-visits] [--minProbability=0.3]');
    process.exit(1);
  }

  console.log(`[predict] categoría=${categoryId} container=${containerName} blobPath=${blobPath}`);

  const model = await aiModelRepo.findByCategoryId(categoryId);
  if (!model) {
    throw new Error(`No hay modelo activo (is_active=1) para category_id=${categoryId}.`);
  }
  if (model.status !== 'PUBLISHED') {
    throw new Error(
      `El modelo activo de category_id=${categoryId} está en status='${model.status}', no 'PUBLISHED' — ` +
      `no hay iteración publicada contra la cual predecir todavía.`
    );
  }

  console.log(`[predict] modelo encontrado — proyecto=${model.customvision_project_id} publishName=${model.last_publish_name} version=${model.model_version}`);

  const buffer = await blobStorageService.downloadFromContainer({ containerName, blobPath });
  console.log(`[predict] foto descargada — ${buffer.length} bytes`);

  const result = await customVisionService.predictImage(
    model.customvision_project_id,
    model.last_publish_name,
    buffer
  );

  const predictions = (result.predictions || [])
    .filter(p => p.probability >= minProbability)
    .sort((a, b) => b.probability - a.probability);

  console.log(`\n[predict] ${predictions.length} detección(es) con probabilidad >= ${minProbability} (de ${result.predictions?.length ?? 0} totales):\n`);
  for (const p of predictions) {
    const pct = (p.probability * 100).toFixed(1);
    const bb = p.boundingBox;
    console.log(`  ${p.tagName.padEnd(15)} ${pct}%   bbox(left=${bb.left.toFixed(3)}, top=${bb.top.toFixed(3)}, width=${bb.width.toFixed(3)}, height=${bb.height.toFixed(3)})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[predict] ERROR:', err.message);
    process.exit(1);
  });
