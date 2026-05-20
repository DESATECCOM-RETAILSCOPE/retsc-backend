function extractGTINFromFilename(filename) {
  if (!filename) return null;
  const base = filename.replace(/\.[^.]+$/, ''); // quitar extensión
  const part = base.split('_')[0];               // tomar antes del primer _
  return /^\d{8}$|^\d{12}$|^\d{13}$/.test(part) ? part : null;
}

function matchImagesToProducts(excelRows, imageFiles) {
  const productsByGtin = new Map(excelRows.map(r => [r.gtin, r]));
  const matched = [];
  const imagesWithoutMatch = [];

  for (const img of imageFiles) {
    const gtin = img.gtinExtracted;
    if (gtin && productsByGtin.has(gtin)) {
      matched.push({ gtin, imageFile: img, productRow: productsByGtin.get(gtin) });
      productsByGtin.delete(gtin); // un match por producto
    } else {
      imagesWithoutMatch.push(img);
    }
  }

  const productsWithoutImage = [...productsByGtin.values()];
  return { matched, imagesWithoutMatch, productsWithoutImage };
}

module.exports = { matchImagesToProducts, extractGTINFromFilename };
