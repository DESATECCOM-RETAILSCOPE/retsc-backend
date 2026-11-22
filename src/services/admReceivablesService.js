/**
 * admReceivablesService.js — Cuentas por cobrar: antigüedad de saldos (con CSV) y facturas con saldo.
 *
 * Para qué sirve: valida los filtros de las pantallas de cuentas por cobrar de DTC, convierte
 *   las filas de la base a camelCase y arma el CSV de antigüedad de saldos.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos:
 *   // TODO: paginación de GET /api/adm/receivables.
 *
 * NOTA: estas rutas son solo DTC, que ve TODAS las empresas. Por eso ?enterpriseId= es un
 *   filtro opcional (optionalPositiveInt) y NO se usa resolveEnterpriseId, que lo exige.
 * NOTA: el CSV usa el MISMO formato que el dashboard (src/utils/csvExport.js, decisión de
 *   María del 27-oct para Excel en español): separador ";", coma decimal, UTF-8 con BOM y CRLF.
 *   El util se reutiliza SIN modificarlo; lo que no cubre (montos siempre con 2 decimales y la
 *   protección contra inyección de fórmulas) se agrega aquí, en el `format` de cada columna.
 */

const receivablesRepo = require('../repositories/admReceivablesRepo');
const { fieldError, oneOf, optionalPositiveInt } = require('../utils/admValidation');

const CURRENCIES = ['CRC', 'USD'];
// Valores aceptados en ?filter= de receivables (nombres que usa la pantalla).
const RECEIVABLE_FILTERS = ['overdue', 'dueSoon', 'followUp'];

// Una fecha de SQL (Date de JavaScript) o texto -> 'AAAA-MM-DD'.
function dateToString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

// "Hoy" en hora de Costa Rica (UTC-6, sin horario de verano) como 'AAAA-MM-DD'.
// Se usa solo para el nombre del archivo CSV. `now` se puede pasar en las pruebas.
function todayCostaRica(now = new Date()) {
  return new Date(now.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

// Filtros comunes: empresa y moneda, ambos opcionales.
function parseCommonFilters(q) {
  return {
    enterpriseId: optionalPositiveInt(q.enterpriseId, 'enterpriseId', 'La empresa'),
    currency: q.currency == null || q.currency === ''
      ? null
      : oneOf(q.currency, 'currency', 'La moneda', CURRENCIES),
  };
}

// Fila de RETSC_ADM_V_AGING (+ nombre de empresa) -> camelCase.
function toAgingDTO(row) {
  return {
    enterpriseId: row.Enterprise_id,
    enterpriseName: row.Enterprise_dsc ?? null,
    currency: String(row.Currency).trim(),
    vigente: Number(row.Vigente),
    vencido1a30: Number(row.Vencido_1_30),
    vencido31a60: Number(row.Vencido_31_60),
    vencido61a90: Number(row.Vencido_61_90),
    vencidoMas90: Number(row.Vencido_mas_90),
    saldoTotal: Number(row.Saldo_total),
    facturasConSaldo: Number(row.Facturas_con_saldo),
  };
}

// Fila de facturas con saldo -> camelCase. Las banderas calculadas en SQL llegan como 1/0
// y se dejan como 1/0, igual que los BIT del resto del módulo.
function toReceivableDTO(row) {
  return {
    invoiceId: row.Invoice_id,
    enterpriseId: row.Enterprise_id,
    enterpriseName: row.Enterprise_dsc ?? null,
    contractId: row.Contract_id,
    invoiceNumber: row.Invoice_number,
    dueDate: dateToString(row.Due_date),
    currency: String(row.Currency).trim(),
    totalAmount: Number(row.Total_amount),
    balance: Number(row.Balance),
    paymentStatus: row.Payment_status,
    daysOverdue: row.Days_overdue == null ? null : Number(row.Days_overdue),
    agingBucket: row.Aging_bucket ?? null,
    nextContactDate: dateToString(row.Next_contact_date),
    lastNote: row.Last_note ?? null,
    overdue: row.Overdue ? 1 : 0,
    dueSoon: row.Due_soon ? 1 : 0,
    followUpDue: row.Follow_up_due ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// Texto seguro para CSV: si empieza con = + - o @, Excel lo ejecutaría como fórmula
// (inyección de fórmulas en CSV). Se le antepone una comilla simple para que quede como texto.
// Solo se aplica a TEXTO: los montos (que pueden ser negativos) usan moneyCell.
// El escape de ";", comillas y saltos de línea lo hace después el util csvExport.
function safeText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

// Monto con 2 decimales y coma decimal (1130.5 -> "1130,50"), como espera Excel en español.
// El util cambia el punto por coma pero no fija los decimales (daría "1130,5"); por eso aquí
// se arma el texto completo y el util lo recibe ya formateado (a un texto no lo modifica).
function moneyCell(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  return Number(value).toFixed(2).replace('.', ',');
}

// Columnas del CSV de antigüedad, en el formato que recibe csvExport.sendCsv:
// { key, header, format }. format(valor) devuelve el texto de la celda.
const AGING_CSV_COLUMNS = [
  { header: 'ID empresa', key: 'enterpriseId' },
  { header: 'Empresa', key: 'enterpriseName', format: safeText },
  { header: 'Moneda', key: 'currency', format: safeText },
  { header: 'Vigente', key: 'vigente', format: moneyCell },
  { header: 'Vencido 1 a 30 días', key: 'vencido1a30', format: moneyCell },
  { header: 'Vencido 31 a 60 días', key: 'vencido31a60', format: moneyCell },
  { header: 'Vencido 61 a 90 días', key: 'vencido61a90', format: moneyCell },
  { header: 'Vencido más de 90 días', key: 'vencidoMas90', format: moneyCell },
  { header: 'Saldo total', key: 'saldoTotal', format: moneyCell },
  { header: 'Facturas con saldo', key: 'facturasConSaldo' },
];

// ---------------------------------------------------------------------------
// Casos de uso
// ---------------------------------------------------------------------------

// GET /api/adm/aging — antigüedad de saldos. Solo DTC.
// Devuelve { format: 'json', aging } o, con ?export=csv, { format: 'csv', filename, columns, rows }
// para que el controlador lo escriba con csvExport.sendCsv (BOM, cabeceras y Content-Disposition).
const getAging = async (query, now = new Date()) => {
  const q = query || {};
  const filters = parseCommonFilters(q);

  let wantsCsv = false;
  if (q.export != null && q.export !== '') {
    if (String(q.export).toLowerCase() !== 'csv') {
      throw fieldError('export', 'El único formato de exportación disponible es csv.');
    }
    wantsCsv = true;
  }

  const aging = (await receivablesRepo.listAging(filters)).map(toAgingDTO);
  if (!wantsCsv) return { format: 'json', aging };

  return {
    format: 'csv',
    filename: `cuentas-por-cobrar-${todayCostaRica(now)}.csv`,
    columns: AGING_CSV_COLUMNS,
    rows: aging,
  };
};

// GET /api/adm/receivables — facturas con saldo para la pantalla de cuentas por cobrar. Solo DTC.
// NOTA: endpoint EXTRA, no está en la tabla de la spec (sección 6); la pantalla lo necesita.
const listReceivables = async (query) => {
  const q = query || {};
  const filters = parseCommonFilters(q);
  if (q.filter != null && q.filter !== '') {
    // Se compara tal cual (sin pasar a mayúsculas): son nombres de la pantalla en camelCase.
    if (!RECEIVABLE_FILTERS.includes(q.filter)) {
      throw fieldError('filter', `El filtro debe ser uno de: ${RECEIVABLE_FILTERS.join(', ')}.`);
    }
    filters.filter = q.filter;
  } else {
    filters.filter = null;
  }
  const rows = await receivablesRepo.listReceivables(filters);
  return rows.map(toReceivableDTO);
};

module.exports = {
  getAging,
  listReceivables,
  // Expuestos solo para las pruebas.
  _safeText: safeText,
  _moneyCell: moneyCell,
  _todayCostaRica: todayCostaRica,
};
