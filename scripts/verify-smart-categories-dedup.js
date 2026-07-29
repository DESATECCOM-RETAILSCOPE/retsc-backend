/**
 * Verificación de deduplicación de categorías smart por empresa (Issue B4 — QA).
 * --------------------------------------------------------------
 * Imprime el resultado de listSmartForEnterprise() y listCommercialCategories()
 * para una empresa dada, y marca si algún nombre de categoría (o de su padre)
 * aparece más de una vez — que es justamente el bug que se reportó.
 * Solo lectura, no modifica nada.
 *
 * Uso:
 *   node scripts/verify-smart-categories-dedup.js <enterpriseId>
 */

require('dotenv').config();
const enterpriseCategoryRepo = require('../src/repositories/enterpriseCategoryRepo');

const ok   = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => console.log('  \x1b[31m✗\x1b[0m ' + m);
const head = (m) => console.log('\n\x1b[1m\x1b[35m' + m + '\x1b[0m');

function checkDuplicates(rows, labelField) {
  const counts = new Map();
  for (const r of rows) {
    const key = r[labelField];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dupes = [...counts.entries()].filter(([, n]) => n > 1);
  return dupes;
}

(async () => {
  const enterpriseId = Number(process.argv[2]);
  if (!enterpriseId) {
    console.error('Uso: node scripts/verify-smart-categories-dedup.js <enterpriseId>');
    process.exit(1);
  }

  head(`Categorías smart (GET /api/enterprises/me/enterprise-categories/smart) — enterprise_id=${enterpriseId}`);
  const smart = await enterpriseCategoryRepo.listSmartForEnterprise(enterpriseId);
  console.table(smart.map(r => ({
    category_id: r.category_id,
    category_dsc: r.category_dsc,
    parent_category_id: r.parent_category_id,
    parent_dsc: r.parent_dsc,
    level_no: r.level_no,
  })));

  const dupCategoryDsc = checkDuplicates(smart, 'category_dsc');
  const dupParentDsc   = checkDuplicates(smart.filter(r => r.parent_dsc), 'parent_dsc');

  if (dupCategoryDsc.length === 0) {
    ok('Ninguna categoría smart repetida por nombre.');
  } else {
    fail(`Categorías smart repetidas: ${dupCategoryDsc.map(([n, c]) => `"${n}" x${c}`).join(', ')}`);
  }

  // Un padre puede legítimamente aparecer varias veces AQUÍ si tiene varias hijas smart
  // distintas (cada fila es una hija distinta) — eso NO es el bug. El bug sería que la
  // MISMA categoría (category_dsc) se repita, lo cual ya se chequea arriba.
  if (dupParentDsc.length > 0) {
    console.log(`  \x1b[90m·\x1b[0m Nota: "${dupParentDsc.map(([n, c]) => `${n} (${c} hijas smart)`).join(', ')}" — esperado si el padre tiene varias hijas smart.`);
  }

  head(`Categorías comerciales (GET /api/enterprises/me/enterprise-categories) — enterprise_id=${enterpriseId}`);
  const commercial = await enterpriseCategoryRepo.listCommercialCategories(enterpriseId);
  console.table(commercial.map(r => ({
    enterprise_category_id: r.enterprise_category_id,
    resolved_category_id: r.resolved_category_id,
    enterprise_category_dsc: r.enterprise_category_dsc,
  })));

  const dupCommercial = checkDuplicates(commercial, 'enterprise_category_dsc');
  if (dupCommercial.length === 0) {
    ok('Ninguna categoría comercial repetida por nombre.');
  } else {
    fail(`Categorías comerciales repetidas: ${dupCommercial.map(([n, c]) => `"${n}" x${c}`).join(', ')}`);
  }

  process.exit(0);
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
