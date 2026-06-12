// Servicio de IA para el pipeline de carga de productos (paso 7).
// Registra la necesidad de entrenamiento de modelos Custom Vision cuando se suben imágenes.
//
// NOTA: Este servicio opera sobre modelos ya existentes (creados por aiInfrastructureService
// cuando se crea una categoría smart). Si un modelo no existe aún para la categoría,
// se crea uno con status PENDING como fallback.
//
// Relación con aiInfrastructureService:
//   - aiInfrastructureService: crea la infraestructura (blob prefix + modelo) al crear categorías
//   - aiService (este archivo): actualiza contadores durante el pipeline de carga de productos

const aiModelRepo  = require('../repositories/aiModelRepo');
const categoryRepo = require('../repositories/categoryRepo');

// Busca categoría por nombre (case-insensitive). Carga todas y filtra en memoria.
// OPTIMIZAR: agregar índice o query directa por nombre si la tabla crece.
async function findCategoryByName(name) {
  const all = await categoryRepo.listActive();
  return all.find(c => c.Category_dsc.toLowerCase() === name.toLowerCase()) ?? null;
}

// Registra que una categoría tiene imágenes nuevas pendientes de entrenar.
// Llamado desde pipelineOrchestrator en el paso 7 (ai_tracking).
//
// Si ya existe un modelo para la categoría: no hace nada (el estado PENDING ya indica
// que hay trabajo pendiente; la lógica de entrenamiento real se activará cuando
// Custom Vision esté configurado).
// Si no existe modelo: lo crea con status PENDING como fallback de seguridad.
async function registerTrainingNeed(enterpriseId, categoryDscs) {
  const results = [];

  for (const dsc of categoryDscs) {
    const cat = await findCategoryByName(dsc);
    if (!cat) {
      results.push({ categoryName: dsc, categoryId: null, action: 'skipped_unknown_category' });
      continue;
    }

    // Buscar modelo existente para esta categoría
    const existing = await aiModelRepo.findByCategoryId(cat.Category_id);

    if (existing) {
      // El modelo ya existe. En el futuro, cuando Custom Vision esté activo,
      // aquí se incrementaría un contador o se dispararía un re-entrenamiento.
      // TODO: implementar lógica de re-entrenamiento cuando lleguen las credenciales CV.
      results.push({
        categoryId:        cat.Category_id,
        modelId:           existing.detection_model_id,
        action:            'already_exists',
        currentStatus:     existing.status,
      });
    } else {
      // Fallback: crear registro si no fue creado por aiInfrastructureService.
      // Esto puede pasar si la categoría existía antes de que se implementara el
      // provisioning automático. El backfill formal está en scripts/backfill-smart-categories.js
      const inserted = await aiModelRepo.insert({
        categoryId: cat.Category_id,
        modelName:  `dtc-${cat.Category_dsc.toLowerCase().replace(/\s+/g, '-')}-v1`,
        status:     'PENDING',
      });
      results.push({
        categoryId: cat.Category_id,
        modelId:    inserted.detection_model_id,
        action:     'created_fallback',
      });
    }
  }

  return results;
}

async function listModels() {
  return aiModelRepo.listAll();
}

module.exports = { registerTrainingNeed, listModels };
