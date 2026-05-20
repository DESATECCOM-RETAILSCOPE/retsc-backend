const XLSX = require('xlsx');

// Mapeo de nombres de columna (case-insensitive, tolerante a tildes) a claves internas
const COLUMN_ALIASES = {
  gtin:        ['gtin'],
  description: ['description', 'descripcion', 'descripción'],
  category:    ['category', 'categoria', 'categoría'],
  subcategory: ['subcategory', 'subcategoria', 'subcategoría'],
  segment:     ['segment', 'segmento'],
  brand:       ['brand', 'marca'],
};
const REQUIRED_KEYS = ['gtin', 'description', 'category'];

function normalizeHeader(h) {
  return String(h)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim();
}

function buildHeaderMap(rawHeaders) {
  const map = {}; // internalKey → rawHeaderName
  for (const raw of rawHeaders) {
    const norm = normalizeHeader(raw);
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(norm) && !map[key]) map[key] = raw;
    }
  }
  return map;
}

// Normaliza un valor de celda GTIN: número con posible cero inicial perdido
function normalizeGTIN(raw) {
  if (raw == null) return '';
  // xlsx puede leer GTINs como números: 36000291452 → debería ser 036000291452
  const str = String(raw).trim().replace(/\.0+$/, ''); // quitar ".0" de floats
  if (!/^\d+$/.test(str)) return str; // no numérico, devolverlo tal cual
  // Si xlsx leyó un GTIN numérico y perdió el cero inicial:
  //   7 dígitos  → EAN8 truncado  → pad a 8
  //   11 dígitos → UPC12 truncado → pad a 12
  //   12 dígitos → UPC12 correcto, no tocar
  //   13 dígitos → EAN13 correcto, no tocar
  if (str.length === 7)  return str.padStart(8, '0');
  if (str.length === 11) return str.padStart(12, '0');
  return str;
}

async function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const errors = [];

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return { headers: [], rows: [], errors: ['El archivo no contiene hojas'] };
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  if (!rawRows || rawRows.length === 0) {
    return { headers: [], rows: [], errors: ['La primera hoja está vacía'] };
  }

  const rawHeaders = Object.keys(rawRows[0]);
  const headerMap = buildHeaderMap(rawHeaders);

  const missingRequired = REQUIRED_KEYS.filter(k => !headerMap[k]);
  if (missingRequired.length > 0) {
    errors.push(`Columnas requeridas faltantes: ${missingRequired.join(', ')}`);
  }

  const seenGTINs = new Set();
  const rows = [];

  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i];
    const rowNum = i + 2; // row 1 = headers

    const gtin = normalizeGTIN(raw[headerMap['gtin']]);
    if (!gtin) {
      errors.push(`Fila ${rowNum}: GTIN vacío`);
      continue;
    }
    if (seenGTINs.has(gtin)) {
      errors.push(`Fila ${rowNum}: GTIN duplicado dentro del Excel (${gtin})`);
      continue;
    }
    seenGTINs.add(gtin);

    rows.push({
      gtin,
      description: raw[headerMap['description']] ?? null,
      category:    raw[headerMap['category']]    ?? null,
      subcategory: raw[headerMap['subcategory']] ?? null,
      segment:     raw[headerMap['segment']]     ?? null,
      brand:       raw[headerMap['brand']]       ?? null,
    });
  }

  return { headers: rawHeaders, rows, errors };
}

async function validateStructure(parsedExcel) {
  const missingColumns = REQUIRED_KEYS.filter(
    k => !parsedExcel.rows.length || parsedExcel.rows[0][k] === undefined
  );
  // structural errors are those about columns/structure, not row-level
  const structuralErrors = parsedExcel.errors.filter(
    e => e.startsWith('Columnas') || e.startsWith('El archivo') || e.startsWith('La primera')
  );
  return {
    valid:          structuralErrors.length === 0,
    missingColumns: parsedExcel.errors.filter(e => e.startsWith('Columnas')),
    rowCount:       parsedExcel.rows.length,
    structuralErrors,
  };
}

module.exports = { parseExcel, validateStructure };
