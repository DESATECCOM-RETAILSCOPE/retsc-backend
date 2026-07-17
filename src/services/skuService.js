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
  volume: ["volume", "volumen"],
  relevant: ["relevant", "relevante", "relevant_feature", "checklist"],
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
    volume:
      headerMap["volume"] && raw[headerMap["volume"]] != null
        ? Number(String(raw[headerMap["volume"]]).replace(",", "."))
        : null,
    relevant:
      headerMap["relevant"] && raw[headerMap["relevant"]] != null
        ? String(raw[headerMap["relevant"]]).trim()
        : null,
  }));
}

// ── lógica principal ───────────────────────────────────────────────────────

const processSkuExcel = async (
  filePath,
  enterpriseCategoryId,
  enterpriseId,
) => {
  // Validar y cargar la categoría comercial — provee enterprise_category_id y resolved_category_id
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

  // detection_category_id: usa la categoría DTC resuelta (smart); si no hay, cae al selected
  const detectionCategoryId =
    entCat.resolved_category_id ?? entCat.selected_category_id;

  const rows = parseSkuExcel(filePath);
  const batchId = crypto.randomUUID();

  const metrics = {
    totalRows: rows.length,
    skusCreated: 0,
    skusUpdated: 0,
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

    // ── 2. Buscar o crear SKU global por EAN ──────────────────────────────
    // NOTA: RETSC_OP_PRODUCTS no existe; Product_dsc y categorías viven
    // directamente en RETSC_OP_SKUS.
    //   selected_category_id  → enterprise_category_id (PK de ENTERPRISE_CATEGORIES)
    //   detection_category_id → resolved_category_id (Category_id smart de CATEGORIES)
    let skuRow = await skuRepo.findSkuByEan(row.gtin);

    const safeDesc = row.description ? row.description.substring(0, 100) : null;

    const isNew = !skuRow;
    if (isNew) {
      skuRow = await skuRepo.insertSku({
        ean: row.gtin,
        productDsc: safeDesc,
        selectedCategoryId: entCat.selected_category_id,  // FK→RETSC_OP_CATEGORIES.Category_id
        detectionCategoryId: entCat.resolved_category_id, // smart category FK→RETSC_OP_CATEGORIES
      });
      metrics.skusCreated++;
    } else {
      const descChanged = safeDesc && safeDesc !== skuRow.Product_dsc;
      if (descChanged) {
        await skuRepo.updateSku(skuRow.SKU_ID, { productDsc: safeDesc });
        metrics.skusUpdated++;
      } else {
        metrics.duplicatesSkipped++;
      }
    }

    // ── 2.1 Asociar el SKU a esta empresa + datos propios del cliente ─────
    // Un SKU global (RETSC_OP_SKUS) recién creado — o ya existente en el catálogo
    // por otra empresa — nunca quedaba vinculado a RETSC_OP_ENTERPRISE_PRODUCT_SEG
    // (bug B5, ya corregido). brand/category/subcategory/volume/relevant del Excel
    // son datos POR-EMPRESA-POR-SKU (a diferencia de selected_category_id/
    // detection_category_id, que son globales en RETSC_OP_SKUS) — se guardan acá.
    // En recargas posteriores del mismo SKU se RESINCRONIZAN (update), no solo se
    // insertan una vez — así una carga con datos corregidos arregla filas viejas
    // en vez de dejarlas pegadas con el valor de la primera carga.
    const clientData = {
      brand: row.brand,
      supplier: row.manufacturer,
      clientCategory: row.category,
      clientSubcategory: row.subcategory,
      volume: row.volume,
      relevantFeature: row.relevant,
    };
    try {
      const existingEntSku = await skuRepo.findEnterpriseSku(enterpriseId, skuRow.SKU_ID);
      if (!existingEntSku) {
        await skuRepo.insertEnterpriseSku({
          enterpriseId,
          skuId: skuRow.SKU_ID,
          ...clientData,
        });
      } else {
        await skuRepo.updateEnterpriseSku(existingEntSku.seg_id, clientData);
      }
    } catch (err) {
      errors.push({ row: row._rowNum, ean: row.gtin, reason: `Error al asociar SKU a la empresa: ${err.message}` });
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
          processStatus: 'ERROR',
          errorCode: 'ENTERPRISE_SKU_LINK_FAILED',
          errorMessage: err.message,
        })
        .catch(() => {});
      continue;
    }

    // ── 3. Log ────────────────────────────────────────────────────────────
    await skuRepo
      .logSkuRow({
        enterpriseId,
        batchId,
        rowNumber: row._rowNum,
        ean: row.gtin,
        skuDescription: row.description,
        selectedCategoryId: entCat.selected_category_id,
        detectionCategoryId,
        processStatus: isNew ? "OK" : "SKIPPED",
      })
      .catch(() => {});
  }

  return { metrics, errors };
};

module.exports = { processSkuExcel };
