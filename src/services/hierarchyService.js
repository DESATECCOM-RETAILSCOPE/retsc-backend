const productRepo = require('../repositories/productRepo');

function toSlug(str) {
  if (!str || !String(str).trim()) return '_general';
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || '_general';
}

function getThreshold() {
  return parseInt(process.env.BLOB_HIERARCHY_THRESHOLD || '500', 10);
}

async function buildBatchCounts(excelRows, enterpriseId) {
  const existing = await productRepo.listByEnterprise(enterpriseId);
  const counts = { category: {}, subcategory: {}, segment: {} };

  const countRow = (row) => {
    const cat = String(row.Category_name || row.category || '').trim();
    const sub = String(row.Subcategory   || row.subcategory || '').trim();
    const seg = String(row.Segment       || row.segment     || '').trim();
    if (cat) counts.category[cat]   = (counts.category[cat]   || 0) + 1;
    if (sub) counts.subcategory[sub] = (counts.subcategory[sub] || 0) + 1;
    if (seg) counts.segment[seg]     = (counts.segment[seg]     || 0) + 1;
  };

  existing.forEach(countRow);
  excelRows.forEach(countRow);
  return counts;
}

async function decidePathForProduct(productRow, enterpriseId, batchCounts) {
  const threshold = getThreshold();
  const cat = String(productRow.category || '').trim();
  const sub = String(productRow.subcategory || '').trim();
  const seg = String(productRow.segment || '').trim();

  const catCount = batchCounts.category[cat] || 0;
  const subCount = batchCounts.subcategory[sub] || 0;

  if (catCount <= threshold) {
    return `${toSlug(cat)}/`;
  }
  if (subCount <= threshold) {
    return `${toSlug(cat)}/${toSlug(sub)}/`;
  }
  return `${toSlug(cat)}/${toSlug(sub)}/${toSlug(seg)}/`;
}

module.exports = { buildBatchCounts, decidePathForProduct, toSlug };
