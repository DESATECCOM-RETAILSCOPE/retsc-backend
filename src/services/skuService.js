const crypto = require("crypto");
const XLSX = require("xlsx");
const skuRepo = require("../repositories/skuRepo");
const entCatRepo = require("../repositories/enterpriseCategoryRepo");

// ── helpers ────────────────────────────────────────────────────────────────

function svcError(msg, statusCode) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  return err;
}

function normalizeHeader(h) {
  return String(h)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

const COLUMN_ALIASES = {
  gtin: [
    "gtin",
    "ean",
    "ean/gtin",
    "codigo",
    "codigo ean",
    "barcode",
    "upc",
    "code",
  ],
  description: [
    "description",
    "descripcion",
    "descripcion",
    "nombre",
    "name",
    "product name",
    "product_name",
  ],
  brand: ["brand", "marca"],
  manufacturer: ["manufacturer", "fabricante", "proveedor", "supplier"],
  category: ["category", "categoria"],
  subcategory: ["subcategory", "subcategoria"],
};
const REQUIRED_KEYS = ["gtin", "description"];

function buildHeaderMap(rawHeaders) {
  const map = {};
  for (const raw of rawHeaders) {
    const norm = normalizeHeader(raw);
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(norm) && !map[key]) map[key] = raw;
    }
  }
  return map;
}

// Normaliza GTIN: corrige cero inicial perdido por lectura numérica del xlsx
function normalizeGTIN(raw) {
  if (raw == null) return "";
  const str = String(raw).trim().replace(/\.0+$/, "");
  if (!/^\d+$/.test(str)) return str;
  if (str.length === 7) return str.padStart(8, "0");
  if (str.length === 11) return str.padStart(12, "0");
  return str;
}

// Validación EAN según spec: numérico + longitud 8, 12 ó 13 + checksum GS1
function validateEAN(gtin) {
  const str = String(gtin ?? "").trim();
  if (!str) return { valid: false, reason: "EAN vacío" };
  if (!/^\d+$/.test(str)) return { valid: false, reason: "EAN no es numérico" };
  if (![8, 12, 13].includes(str.length))
    return {
      valid: false,
      reason: "EAN inválido — debe tener 8, 12 o 13 dígitos",
    };

  // Validación de dígito verificador (checksum GS1)
  // Aplica a EAN-8, UPC-A y EAN-13. El último dígito es el verificador.
  const digits = str.split("").map(Number);
  const checkDigit = digits[digits.length - 1];
  const body = digits.slice(0, -1);

  // De derecha a izquierda, los dígitos pesan alternadamente 3 y 1
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const fromRight = body.length - 1 - i;
    const weight = fromRight % 2 === 0 ? 3 : 1;
    sum += body[i] * weight;
  }
  const computedCheck = (10 - (sum % 10)) % 10;

  if (computedCheck !== checkDigit) {
    return {
      valid: false,
      reason: "EAN inválido — dígito verificador (checksum) incorrecto",
    };
  }

  return { valid: true };
}

// ── parseo Excel ───────────────────────────────────────────────────────────

function parseSkuExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw svcError("El archivo no contiene hojas", 400);
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  if (!rawRows || rawRows.length === 0) {
    throw svcError("La primera hoja está vacía", 400);
  }

  const rawHeaders = Object.keys(rawRows[0]);
  const headerMap = buildHeaderMap(rawHeaders);

  const missing = REQUIRED_KEYS.filter((k) => !headerMap[k]);
  if (missing.length > 0) {
    throw svcError(
      `Archivo inválido o columnas faltantes: ${missing.join(", ")}`,
      400,
    );
  }

  return rawRows.map((raw, i) => ({
    _rowNum: i + 2,
    gtin: normalizeGTIN(raw[headerMap["gtin"]]),
    description: raw[headerMap["description"]]
      ? String(raw[headerMap["description"]]).trim()
      : null,
    brand:
      headerMap["brand"] && raw[headerMap["brand"]]
        ? String(raw[headerMap["brand"]]).trim()
        : null,
    manufacturer:
      headerMap["manufacturer"] && raw[headerMap["manufacturer"]]
        ? String(raw[headerMap["manufacturer"]]).trim()
        : null,
    category:
      headerMap["category"] && raw[headerMap["category"]]
        ? String(raw[headerMap["category"]]).trim()
        : null,
    subcategory:
      headerMap["subcategory"] && raw[headerMap["subcategory"]]
        ? String(raw[headerMap["subcategory"]]).trim()
        : null,
  }));
}

// ── lógica principal ───────────────────────────────────────────────────────

const processSkuExcel = async (
  filePath,
  enterpriseCategoryId,
  enterpriseId,
) => {
  // Validar y cargar la categoría comercial — también provee detection_category_id
  const entCat = await entCatRepo.findEnterpriseCategoryById(
    Number(enterpriseCategoryId),
    enterpriseId,
  );
  if (!entCat) {
    throw svcError(
      "La categoría comercial no existe o no pertenece a este enterprise",
      400,
    );
  }

  // detection_category_id: usa la categoría DTC resuelta; si no hay, cae al selected
  const detectionCategoryId =
    entCat.resolved_category_id ?? entCat.selected_category_id;

  const rows = parseSkuExcel(filePath);
  const batchId = crypto.randomUUID();

  const metrics = {
    totalRows: rows.length,
    skusCreated: 0,
    skusUpdated: 0,
    productsCreated: 0,
    enterpriseSkusCreated: 0,
    categoriesResolved: 0,
    duplicatesSkipped: 0,
    errorsCount: 0,
  };
  const errors = [];

  for (const row of rows) {
    // ── 1. Validar EAN ────────────────────────────────────────────────────
    const eanCheck = validateEAN(row.gtin);
    if (!eanCheck.valid) {
      errors.push({ row: row._rowNum, ean: row.gtin, reason: eanCheck.reason });
      metrics.errorsCount++;

      await skuRepo
        .logSkuRow({
          enterpriseId,
          batchId,
          rowNumber: row._rowNum,
          ean: row.gtin,
          skuDescription: row.description,
          selectedCategoryId: entCat.selected_category_id,
          detectionCategoryId,
          processStatus: "ERROR",
          errorCode: "INVALID_EAN",
          errorMessage: eanCheck.reason,
        })
        .catch(() => {}); // log es best-effort
      continue;
    }

    // ── 2. Buscar SKU global por EAN ──────────────────────────────────────
    let skuRow = await skuRepo.findSkuByEan(row.gtin);

    const safeDesc = row.description ? row.description.substring(0, 100) : null;

    if (!skuRow) {
      // Recuperación ante fallo parcial: el producto pudo haberse insertado
      // en un intento previo aunque el SKU no llegó a crearse
      let product = await skuRepo.findProductByKey(row.gtin);

      if (!product) {
        product = await skuRepo.insertProduct({
          productDsc: safeDesc,
          categoryId: null,
          productKey: row.gtin,
          brand: row.brand ?? null,
          clientCategory: row.category ?? null,
          clientSubcategory: row.subcategory ?? null,
          supplier: row.manufacturer ?? null,
        });
        metrics.productsCreated++;
      }

      const sku = await skuRepo.insertSku({
        ean: row.gtin,
        productId: product.product_id,
      });
      metrics.skusCreated++;

      skuRow = {
        SKU_ID: sku.SKU_ID,
        EAN: sku.EAN,
        product_id: sku.product_id,
        Product_dsc: product.Product_dsc,
        Brand: product.Brand,
      };
    } else if (skuRow.product_id) {
      // SKU existente: actualizar campos si cambiaron
      const descChanged = safeDesc && safeDesc !== skuRow.Product_dsc;
      const brandChanged = row.brand != null && row.brand !== skuRow.Brand;
      const catChanged =
        row.category != null && row.category !== skuRow.client_category;
      const subCatChanged =
        row.subcategory != null &&
        row.subcategory !== skuRow.client_subcategory;
      const supplierChanged =
        row.manufacturer != null && row.manufacturer !== skuRow.Supplier;
      if (
        descChanged ||
        brandChanged ||
        catChanged ||
        subCatChanged ||
        supplierChanged
      ) {
        await skuRepo.updateProduct(skuRow.product_id, {
          ...(descChanged && { productDsc: safeDesc }),
          ...(brandChanged && { brand: row.brand }),
          ...(catChanged && { clientCategory: row.category }),
          ...(subCatChanged && { clientSubcategory: row.subcategory }),
          ...(supplierChanged && { supplier: row.manufacturer }),
        });
        metrics.skusUpdated++;
      }
    }

    // ── 3. Segmentación enterprise ─────────────────────────────────────────
    const entSku = await skuRepo.findEnterpriseSku(enterpriseId, skuRow.SKU_ID);

    if (!entSku) {
      await skuRepo.insertEnterpriseSku({
        enterpriseId,
        skuId: skuRow.SKU_ID,
        selectedCategoryId: entCat.selected_category_id,
        detectionCategoryId,
      });
      metrics.enterpriseSkusCreated++;
      metrics.categoriesResolved++;
    } else {
      metrics.duplicatesSkipped++;
    }

    // ── 4. Log de auditoría ────────────────────────────────────────────────
    await skuRepo
      .logSkuRow({
        enterpriseId,
        batchId,
        rowNumber: row._rowNum,
        ean: row.gtin,
        skuDescription: row.description,
        selectedCategoryId: entCat.selected_category_id,
        detectionCategoryId,
        processStatus: entSku ? "SKIPPED" : "OK",
      })
      .catch(() => {});
  }

  return { metrics, errors };
};

module.exports = { processSkuExcel };
