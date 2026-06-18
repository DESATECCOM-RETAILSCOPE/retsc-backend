// Script de migración: para cada categoría con is_smart_dtc=1 y status='ACTIVE' que NO
// tenga registro en RETSC_AI_DETECTION_MODELS, dispara provisionForCategory() del
// aiInfrastructureService.
//
// Pre-requisito: la migración 003_add_prefix_to_global_blob_containers.sql debe estar
// corrida antes de ejecutar este script (necesita la columna prefix).
//
// Uso:
//   node scripts/backfill-smart-categories.js [--dry-run]
//   npm run backfill:smart-categories -- --dry-run   (dry-run: solo lista, no inserta)
//   npm run backfill:smart-categories                (real: aprovisiona cada categoría faltante)
//
// Si se corre dos veces, las categorías ya aprovisionadas aparecen como [ALREADY_EXISTS]
// y no se duplican (idempotente).

require('dotenv').config();
const { getPool }             = require('../src/config/db');
const aiInfrastructureService = require('../src/services/aiInfrastructureService');

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? '[DRY-RUN] No se aplicarán cambios.' : '[RUN] Aplicando provisioning real.');

  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT c.Category_id AS category_id, c.Category_dsc AS category_dsc
    FROM RETSC_OP_CATEGORIES c
    WHERE c.is_smart_dtc = 1 AND c.status = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM RETSC_AI_DETECTION_MODELS m WHERE m.category_id = c.Category_id
      )
    ORDER BY c.Category_id;
  `);

  const pending = result.recordset;
  console.log(`Categorías smart sin infraestructura: ${pending.length}`);
  pending.forEach(c => console.log(`  - ${c.category_id}: ${c.category_dsc}`));

  if (dryRun || pending.length === 0) {
    console.log('Saliendo.');
    process.exit(0);
  }

  const summary = { ok: 0, pending_azure: 0, errors: 0 };
  for (const cat of pending) {
    try {
      const res = await aiInfrastructureService.provisionForCategory({
        categoryId:   cat.category_id,
        categoryName: cat.category_dsc,
      });
      console.log(`  [${res.status}] ${cat.category_dsc}${res.errors.length ? ' — ' + res.errors.join(', ') : ''}`);
      if (res.status === 'PROVISIONED' || res.status === 'ALREADY_EXISTS') summary.ok++;
      else if (res.status === 'PENDING') summary.pending_azure++;
      else summary.errors++;
    } catch (err) {
      console.error(`  [ERROR] ${cat.category_dsc}:`, err.message);
      summary.errors++;
    }
  }

  console.log('\nResumen:', summary);
  process.exit(0);
})();
