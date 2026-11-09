// Exportación CSV del Dashboard web (decisión de María, 27-oct-2026).
//
//   · Nombre: pantalla_tarjeta_empresa_desde_hasta.csv
//       ej. cumplimiento_ranking-tiendas_unilever_2026-07-01_2026-09-30.csv
//   · Primera fila: encabezados legibles.
//   · Para Excel en español: separador ";" y UTF-8 con BOM.
//   · Decimales con coma (87,4): con separador ";" Excel en español espera coma
//     decimal; con punto, lee "87.4" como texto o como fecha.
//   · Se escribe en tandas al response en vez de armar todo el archivo en memoria,
//     para que un reporte grande no se trabe. Acepta un array o un iterable async.

const SEPARATOR = ';';
const EOL = '\r\n';
const BOM = '\uFEFF';
const BATCH_SIZE = 500;

// Sufijos legales que no aportan al nombre del archivo ("Unilever C.A." → "unilever").
const LEGAL_SUFFIXES = new Set(['sa', 's-a', 'ca', 'c-a', 'srl', 's-r-l', 'ltda', 'inc', 'corp', 'llc']);

function slugify(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function enterpriseSlug(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(slugify(words[words.length - 1]))) {
    words.pop();
  }
  return slugify(words.join(' '));
}

// Las partes vacías se omiten (por ejemplo, pantalla 4 no tiene empresa ni fechas).
function buildCsvFilename({ pantalla, tarjeta, empresa, desde, hasta }) {
  const parts = [slugify(pantalla), slugify(tarjeta)];
  if (empresa) parts.push(enterpriseSlug(empresa));
  if (desde) parts.push(desde);
  if (hasta) parts.push(hasta);
  return `${parts.filter(Boolean).join('_')}.csv`;
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(value).replace('.', ',');
  }
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return String(value);
}

function escapeField(text) {
  if (/[;"\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

// columns: [{ key, header, format? }]. format(valor, fila) permite un formato propio.
function toCsvLine(row, columns) {
  return columns
    .map((c) => escapeField(formatValue(c.format ? c.format(row[c.key], row) : row[c.key])))
    .join(SEPARATOR);
}

function headerLine(columns) {
  return columns.map((c) => escapeField(String(c.header))).join(SEPARATOR);
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Escribe el CSV completo en el response. rows: array o iterable async de objetos.
async function sendCsv(res, { filename, columns, rows }) {
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('Cache-Control', 'no-store');

  res.write(BOM + headerLine(columns) + EOL);

  let buffer = [];
  const flush = () => {
    if (buffer.length) {
      res.write(buffer.join(EOL) + EOL);
      buffer = [];
    }
  };

  if (rows && typeof rows[Symbol.asyncIterator] === 'function') {
    for await (const row of rows) {
      buffer.push(toCsvLine(row, columns));
      if (buffer.length >= BATCH_SIZE) flush();
    }
  } else {
    for (const row of rows || []) {
      buffer.push(toCsvLine(row, columns));
      if (buffer.length >= BATCH_SIZE) flush();
    }
  }
  flush();
  res.end();
}

// true si el request pide CSV (?export=csv).
function wantsCsv(req) {
  return String(req.query?.export ?? '').trim().toLowerCase() === 'csv';
}

module.exports = {
  sendCsv,
  wantsCsv,
  buildCsvFilename,
  enterpriseSlug,
  slugify,
  toCsvLine,
  headerLine,
  formatValue,
  SEPARATOR,
  BOM,
};
