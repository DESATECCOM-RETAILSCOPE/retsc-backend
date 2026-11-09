// Fábrica de handlers para las tarjetas del Dashboard web (Parte B).
// Todas las tarjetas hacen lo mismo:
//   1. resuelven filtros y empresa con utils/dashboardFilters (por pantalla)
//   2. piden los datos al repositorio
//   3. responden JSON { success, filtros, data }, o el CSV de la tarjeta con ?export=csv
//
// Uso:
//   const handler = cardHandler({
//     pantalla: 'cumplimiento',
//     tarjeta:  'ranking-tiendas',            // o (params) => `composicion-${params.por}`
//     params:   (req) => ({ limit: ... }),    // parámetros propios (opcional)
//     fetch:    (filtros, params) => repo.x(filtros, params),
//     columns:  [{ key, header }],            // columnas del CSV
//   });
// fetch puede devolver un array (tabla) o un objeto (KPI): el CSV de un KPI sale
// con una sola fila.

const enterpriseRepo = require('../repositories/enterpriseRepo');
const { resolveFilters } = require('./dashboardFilters');
const { sendCsv, wantsCsv, buildCsvFilename } = require('./csvExport');

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function handleError(res, err, scope = 'dashboard') {
  const status = err.statusCode || 500;
  if (status === 500) console.error(`[${scope}]`, err);
  return res.status(status).json({
    success: false,
    message: status === 500 ? 'Error al obtener los datos del dashboard.' : err.message,
  });
}

async function enterpriseName(enterpriseId) {
  if (enterpriseId == null) return null;
  try {
    const e = await enterpriseRepo.findById(enterpriseId);
    return e?.Enterprise_dsc || `empresa-${enterpriseId}`;
  } catch {
    return `empresa-${enterpriseId}`;
  }
}

function cardHandler({ pantalla, tarjeta, params = () => ({}), fetch, columns }) {
  return async (req, res) => {
    try {
      const filtros = resolveFilters(req, pantalla);
      const extra   = params(req);
      const data    = await fetch(filtros, extra);

      if (wantsCsv(req)) {
        const nombreTarjeta = typeof tarjeta === 'function' ? tarjeta(extra) : tarjeta;
        const filename = buildCsvFilename({
          pantalla,
          tarjeta: nombreTarjeta,
          empresa: await enterpriseName(filtros.enterpriseId),
          desde:   filtros.desde,
          hasta:   filtros.hasta,
        });
        const rows = Array.isArray(data) ? data : (data ? [data] : []);
        return await sendCsv(res, { filename, columns, rows });
      }

      return res.json({ success: true, filtros: { ...filtros, ...extra }, data });
    } catch (err) {
      return handleError(res, err, `dashboard/${pantalla}`);
    }
  };
}

// Período anterior de la misma duración, inmediatamente antes de [desde, hasta].
// Sirve para la variación de un KPI ("+2,1 pts frente al período anterior").
function periodoAnterior({ desde, hastaExclusive }) {
  const d0 = new Date(`${desde}T00:00:00.000Z`);
  const d1 = new Date(`${hastaExclusive}T00:00:00.000Z`);
  const dias = Math.round((d1 - d0) / 86400000);
  const prevDesde = new Date(d0);
  prevDesde.setUTCDate(prevDesde.getUTCDate() - dias);
  const prevHasta = new Date(d0);
  prevHasta.setUTCDate(prevHasta.getUTCDate() - 1);
  return {
    desde:          prevDesde.toISOString().slice(0, 10),
    hasta:          prevHasta.toISOString().slice(0, 10),
    hastaExclusive: desde,
  };
}

// Redondeo a 1 decimal; null si no hay valor.
function round1(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  return Math.round(Number(v) * 10) / 10;
}

module.exports = { cardHandler, handleError, httpError, periodoAnterior, round1, enterpriseName };
