const aiModelRepo  = require('../repositories/aiModelRepo');
const categoryRepo = require('../repositories/categoryRepo');

// Busca categoría por nombre (case-insensitive)
async function findCategoryByName(name) {
  const all = await categoryRepo.listActive();
  return all.find(c => c.Category_dsc.toLowerCase() === name.toLowerCase()) ?? null;
}

async function registerTrainingNeed(enterpriseId, categoryDscs) {
  const results = [];
  const allModels = await aiModelRepo.listAll();

  for (const dsc of categoryDscs) {
    const cat = await findCategoryByName(dsc);
    if (!cat) {
      results.push({ categoryName: dsc, categoryId: null, action: 'skipped_unknown_category' });
      continue;
    }

    const existing = allModels.find(m => m.Category_id === cat.Category_id);

    if (existing) {
      const newCount = (existing.Pending_images_count || 0) + 1;
      await aiModelRepo.update(existing.Model_id, { Pending_images_count: newCount, Updated_date: new Date().toISOString() });
      results.push({ categoryId: cat.Category_id, modelId: existing.Model_id, action: 'updated', pendingCount: newCount });
    } else {
      const inserted = await aiModelRepo.insert({
        Category_id:           cat.Category_id,
        Status:                'pending_training',
        Version:               '1.0',
        Pending_images_count:  1,
        Created_date:          new Date().toISOString(),
        Updated_date:          new Date().toISOString(),
      });
      results.push({ categoryId: cat.Category_id, modelId: inserted.Model_id, action: 'created', pendingCount: 1 });
    }
  }
  return results;
}

async function listModels() {
  return aiModelRepo.listAll();
}

module.exports = { registerTrainingNeed, listModels };
