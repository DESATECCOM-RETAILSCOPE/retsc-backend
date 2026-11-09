// Dashboard web (Parte B), pantalla 2: Cumplimiento.
// Rutas en routes/dashboardRoutes.js, bajo /api/dashboard/cumplimiento/*.
//
// Un endpoint por tarjeta. Todos:
//   · resuelven filtros y empresa con utils/dashboardFilters (DTC elige la empresa;
//     un cliente ve siempre la suya y recibe 403 si pide otra)
//   · responden JSON { success, filtros, data }, o el CSV de la tarjeta con ?export=csv
//     (formato acordado con María: utils/csvExport)
//
// La tendencia y el top 5 de tiendas del Resumen usan estos mismos endpoints
// (tendencia y ranking-tiendas con limit=5).

const repo = require('../repositories/dashboardCumplimientoRepo');
const { cardHandler: baseCardHandler, httpError } = require('../utils/dashboardCard');

const PANTALLA = 'cumplimiento';

// Parámetros propios de algunas tarjetas.
function parseAgrupar(value) {
  const v = String(value ?? 'semana').trim().toLowerCase();
  if (!repo.AGRUPACIONES.includes(v)) {
    throw httpError(400, `El parámetro "agrupar" debe ser uno de: ${repo.AGRUPACIONES.join(', ')}.`);
  }
  return v;
}

function parseLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > 100) {
    throw httpError(400, 'El parámetro "limit" debe ser un número entre 1 y 100.');
  }
  return Number(s);
}

function parsePor(value) {
  const v = String(value ?? 'marca').trim().toLowerCase();
  if (!repo.DIMENSIONES.includes(v)) {
    throw httpError(400, `El parámetro "por" debe ser uno de: ${repo.DIMENSIONES.join(', ')}.`);
  }
  return v;
}

// Agrega el porcentaje de cada valor sobre el total (composición en góndola).
function withShare(rows) {
  const total = rows.reduce((acc, r) => acc + (Number(r.cantidad) || 0), 0);
  return rows.map((r) => ({
    ...r,
    porcentaje: total > 0 ? Math.round((Number(r.cantidad) * 1000) / total) / 10 : null,
  }));
}

// Todas las tarjetas de esta pantalla usan los filtros de 'cumplimiento'.
const cardHandler = (opts) => baseCardHandler({ pantalla: PANTALLA, ...opts });

const tendencia = cardHandler({
  tarjeta: (p) => `tendencia-${p.agrupar}`,
  params:  (req) => ({ agrupar: parseAgrupar(req.query.agrupar) }),
  fetch:   (f, p) => repo.tendencia(f, p),
  columns: [
    { key: 'periodo',               header: 'Período (inicio)' },
    { key: 'visitas',               header: 'Visitas' },
    { key: 'cumplimiento_promedio', header: 'Cumplimiento promedio (%)' },
    { key: 'cumplimiento_minimo',   header: 'Cumplimiento mínimo (%)' },
    { key: 'cumplimiento_maximo',   header: 'Cumplimiento máximo (%)' },
  ],
});

const visitas = cardHandler({
  tarjeta: 'visitas',
  fetch:   (f) => repo.visitas(f),
  columns: [
    { key: 'fecha_visita',            header: 'Fecha de visita' },
    { key: 'visit_id',                header: 'Visita' },
    { key: 'tienda',                  header: 'Tienda' },
    { key: 'cumplimiento_pct',        header: 'Cumplimiento (%)' },
    { key: 'productos_esperados',     header: 'Esperados' },
    { key: 'productos_detectados',    header: 'Detectados' },
    { key: 'faltantes',               header: 'Faltantes' },
    { key: 'prioritarios_faltantes',  header: 'Prioritarios faltantes' },
    { key: 'en_exceso_fuera_surtido', header: 'Exceso fuera de surtido' },
    { key: 'en_exceso_no_autorizado', header: 'Exceso no autorizado' },
  ],
});

const rankingTiendas = cardHandler({
  tarjeta: 'ranking-tiendas',
  params:  (req) => ({ limit: parseLimit(req.query.limit) }),
  fetch:   (f, p) => repo.rankingTiendas(f, p),
  columns: [
    { key: 'tienda',                 header: 'Tienda' },
    { key: 'cadena',                 header: 'Cadena' },
    { key: 'formato',                header: 'Formato' },
    { key: 'visitas',                header: 'Visitas' },
    { key: 'cumplimiento_promedio',  header: 'Cumplimiento promedio (%)' },
    { key: 'faltantes',              header: 'Faltantes' },
    { key: 'prioritarios_faltantes', header: 'Prioritarios faltantes' },
  ],
});

const rankingCadenas = cardHandler({
  tarjeta: 'ranking-cadenas',
  fetch:   (f) => repo.rankingCadenas(f),
  columns: [
    { key: 'cadena',                 header: 'Cadena' },
    { key: 'formato',                header: 'Formato' },
    { key: 'visitas',                header: 'Visitas' },
    { key: 'cumplimiento_promedio',  header: 'Cumplimiento promedio (%)' },
    { key: 'faltantes',              header: 'Faltantes' },
    { key: 'prioritarios_faltantes', header: 'Prioritarios faltantes' },
  ],
});

const excesoPrioritarios = cardHandler({
  tarjeta: 'exceso-prioritarios',
  fetch:   (f) => repo.excesoPrioritarios(f),
  columns: [
    { key: 'fecha_visita',               header: 'Fecha de visita' },
    { key: 'visit_id',                   header: 'Visita' },
    { key: 'productos_esperados',        header: 'Esperados' },
    { key: 'pct_exceso_fuera_surtido',   header: 'Exceso fuera de surtido (%)' },
    { key: 'pct_exceso_no_autorizado',   header: 'Exceso no autorizado (%)' },
    { key: 'pct_prioritarios_faltantes', header: 'Prioritarios faltantes (%)' },
  ],
});

const composicion = cardHandler({
  tarjeta: (p) => `composicion-${p.por}`,
  params:  (req) => ({ por: parsePor(req.query.por) }),
  fetch:   async (f, p) => withShare(await repo.composicion(f, p)),
  columns: [
    { key: 'valor',      header: 'Valor' },
    { key: 'cantidad',   header: 'Cantidad' },
    { key: 'porcentaje', header: 'Participación (%)' },
  ],
});

module.exports = {
  tendencia,
  visitas,
  rankingTiendas,
  rankingCadenas,
  excesoPrioritarios,
  composicion,
  // exportados para los tests
  _internals: { parseAgrupar, parseLimit, parsePor, withShare },
};
