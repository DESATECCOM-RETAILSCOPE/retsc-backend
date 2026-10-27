// Dashboard web (Parte B), pantalla 2: Cumplimiento.
//
// Lee SOLO de los snapshots congelados por visita (regla de B2: el pasado no se
// recalcula contra el surtido actual):
//   RETSC_EX_ASSORTMENT_COMPLIANCE        (una fila por visita y categoría)
//   RETSC_EX_ASSORTMENT_COMPLIANCE_SHARE  (sin columna de empresa: se une por compliance_id)
// Los ejes de tiempo usan RETSC_EX_VISIT.Visit_start (fecha real de la visita).
//
// Queries basados en el anexo del plan (secciones 1 a 4), con estos ajustes:
//   · Filtros opcionales iguales en todas las tarjetas (category, chain, format): si
//     llegan en NULL no filtran. El anexo los ponía solo en algunos queries; el plan
//     pide que cambiar un filtro actualice todas las tarjetas.
//   · Fechas con  Visit_start >= @desde AND Visit_start < @hastaExclusive  en vez de
//     BETWEEN, para no perder las visitas del último día después de las 00:00.
//   · Cadena y formato salen del snapshot (c.Supermarketchain_id, c.Format), no del
//     catálogo actual. El nombre de la cadena viene de RETSC_OP_SMKTCHAINS (verificado
//     en B4, 26-oct-2026).
//   · Una sola fila por visita y categoría: la más reciente (mayor calculado_en).
//     Cada recálculo del cumplimiento inserta una fila nueva en vez de reemplazar la
//     anterior (en QA, la visita 31 tiene 22 filas). Sin este filtro, una visita
//     reprocesada pesa varias veces en promedios, conteos y totales. Cada fila sigue
//     siendo un snapshot congelado de su visita: se elige el último, no se recalcula.
//
// Recibe los filtros ya validados por utils/dashboardFilters.resolveFilters.

const { getPool, sql } = require('../config/db');

const COMPLIANCE = 'RETSC_EX_ASSORTMENT_COMPLIANCE';
const SHARE      = 'RETSC_EX_ASSORTMENT_COMPLIANCE_SHARE';
const VISIT      = 'RETSC_EX_VISIT';
const RETAILER   = 'RETSC_OP_RETAILER';
const CHAINS     = 'RETSC_OP_SMKTCHAINS';

// Lunes de la semana de una fecha, sin depender de @@DATEFIRST del servidor.
const WEEK_START = (expr) =>
  `DATEADD(DAY, -((DATEPART(WEEKDAY, ${expr}) + @@DATEFIRST - 2) % 7), ${expr})`;

const PERIOD_EXPR = {
  dia:    'CAST(v.Visit_start AS DATE)',
  semana: `CAST(${WEEK_START('CAST(v.Visit_start AS DATE)')} AS DATE)`,
  mes:    'DATEFROMPARTS(YEAR(v.Visit_start), MONTH(v.Visit_start), 1)',
};

const DIMENSIONES = ['marca', 'fabricante', 'subcategoria', 'presentacion'];

// Última fila de cumplimiento por visita y categoría. Los queries leen de "c" en vez
// de la tabla directa. Desempate por compliance_id si calculado_en coincide.
const LATEST = `
  ;WITH c AS (
    SELECT t.*
    FROM (
      SELECT x.*,
             ROW_NUMBER() OVER (
               PARTITION BY x.visit_id, x.category
               ORDER BY x.calculado_en DESC, x.compliance_id DESC
             ) AS rn
      FROM ${COMPLIANCE} x
      WHERE x.enterprise_id = @enterpriseId
    ) t
    WHERE t.rn = 1
  )
`;

// WHERE común a todas las tarjetas. Asume alias c (COMPLIANCE) y v (VISIT).
const BASE_WHERE = `
  c.enterprise_id = @enterpriseId
  AND (@category IS NULL OR c.category = @category)
  AND (@chain    IS NULL OR c.Supermarketchain_id = @chain)
  AND (@format   IS NULL OR c.Format = @format)
  AND v.Visit_start >= @desde
  AND v.Visit_start <  @hastaExclusive
`;

async function baseRequest(f) {
  const pool = await getPool();
  return pool.request()
    .input('enterpriseId',   sql.Int,          f.enterpriseId)
    .input('category',       sql.Int,          f.category)
    .input('chain',          sql.Int,          f.chain)
    .input('format',         sql.NVarChar(50), f.format)
    .input('desde',          sql.Date,         f.desde)
    .input('hastaExclusive', sql.Date,         f.hastaExclusive);
}

// Tarjeta "Tendencia de cumplimiento" (anexo 1, rollup). agrupar: dia | semana | mes.
async function tendencia(f, { agrupar }) {
  const period = PERIOD_EXPR[agrupar];
  if (!period) throw new Error(`agrupar inválido: ${agrupar}`);
  const r = await (await baseRequest(f)).query(`${LATEST}
    SELECT ${period} AS periodo,
           COUNT(DISTINCT c.visit_id) AS visitas,
           CAST(AVG(CAST(c.cumplimiento_pct AS DECIMAL(9,4))) AS DECIMAL(5,1)) AS cumplimiento_promedio,
           CAST(MIN(c.cumplimiento_pct) AS DECIMAL(5,1)) AS cumplimiento_minimo,
           CAST(MAX(c.cumplimiento_pct) AS DECIMAL(5,1)) AS cumplimiento_maximo
    FROM c
    INNER JOIN ${VISIT} v ON v.Visit_id = c.visit_id
    WHERE ${BASE_WHERE}
    GROUP BY ${period}
    ORDER BY periodo;
  `);
  return r.recordset;
}

// Tabla por visita debajo de la tendencia (anexo 1, detalle). Más reciente primero.
async function visitas(f) {
  const r = await (await baseRequest(f)).query(`${LATEST}
    SELECT CAST(v.Visit_start AS DATE) AS fecha_visita,
           c.visit_id,
           v.Retailer_id,
           rt.Retailer_dsc AS tienda,
           CAST(c.cumplimiento_pct AS DECIMAL(5,1)) AS cumplimiento_pct,
           c.productos_esperados,
           c.productos_detectados,
           c.faltantes,
           c.prioritarios_faltantes,
           c.en_exceso_fuera_surtido,
           c.en_exceso_no_autorizado
    FROM c
    INNER JOIN ${VISIT} v ON v.Visit_id = c.visit_id
    LEFT JOIN ${RETAILER} rt ON rt.Retailer_id = v.Retailer_id
    WHERE ${BASE_WHERE}
    ORDER BY v.Visit_start DESC, c.visit_id DESC;
  `);
  return r.recordset;
}

// Ranking por tienda (anexo 2). limit opcional (el Resumen usa el top 5).
async function rankingTiendas(f, { limit } = {}) {
  const req = await baseRequest(f);
  req.input('limit', sql.Int, limit ?? null);
  const r = await req.query(`${LATEST}
    SELECT TOP (ISNULL(@limit, 2147483647))
           v.Retailer_id,
           rt.Retailer_dsc AS tienda,
           c.Supermarketchain_id,
           ch.Supermarketchain AS cadena,
           c.Format AS formato,
           COUNT(DISTINCT c.visit_id) AS visitas,
           CAST(AVG(CAST(c.cumplimiento_pct AS DECIMAL(9,4))) AS DECIMAL(5,1)) AS cumplimiento_promedio,
           SUM(c.faltantes) AS faltantes,
           SUM(c.prioritarios_faltantes) AS prioritarios_faltantes
    FROM c
    INNER JOIN ${VISIT} v ON v.Visit_id = c.visit_id
    LEFT JOIN ${RETAILER} rt ON rt.Retailer_id = v.Retailer_id
    LEFT JOIN ${CHAINS} ch ON ch.Supermarketchain_id = c.Supermarketchain_id
    WHERE ${BASE_WHERE}
    GROUP BY v.Retailer_id, rt.Retailer_dsc, c.Supermarketchain_id, ch.Supermarketchain, c.Format
    ORDER BY cumplimiento_promedio DESC, visitas DESC;
  `);
  return r.recordset;
}

// Ranking por cadena + formato (anexo 2), con el nombre de la cadena.
async function rankingCadenas(f) {
  const r = await (await baseRequest(f)).query(`${LATEST}
    SELECT c.Supermarketchain_id,
           ch.Supermarketchain AS cadena,
           c.Format AS formato,
           COUNT(DISTINCT c.visit_id) AS visitas,
           CAST(AVG(CAST(c.cumplimiento_pct AS DECIMAL(9,4))) AS DECIMAL(5,1)) AS cumplimiento_promedio,
           SUM(c.faltantes) AS faltantes,
           SUM(c.prioritarios_faltantes) AS prioritarios_faltantes
    FROM c
    INNER JOIN ${VISIT} v ON v.Visit_id = c.visit_id
    LEFT JOIN ${CHAINS} ch ON ch.Supermarketchain_id = c.Supermarketchain_id
    WHERE ${BASE_WHERE}
    GROUP BY c.Supermarketchain_id, ch.Supermarketchain, c.Format
    ORDER BY cumplimiento_promedio DESC, visitas DESC;
  `);
  return r.recordset;
}

// Evolución de exceso y prioritarios faltantes (anexo 3): % sobre esperados, por visita.
async function excesoPrioritarios(f) {
  const r = await (await baseRequest(f)).query(`${LATEST}
    SELECT CAST(v.Visit_start AS DATE) AS fecha_visita,
           c.visit_id,
           c.productos_esperados,
           CAST(c.en_exceso_fuera_surtido * 100.0 / NULLIF(c.productos_esperados, 0) AS DECIMAL(5,1)) AS pct_exceso_fuera_surtido,
           CAST(c.en_exceso_no_autorizado * 100.0 / NULLIF(c.productos_esperados, 0) AS DECIMAL(5,1)) AS pct_exceso_no_autorizado,
           CAST(c.prioritarios_faltantes  * 100.0 / NULLIF(c.productos_esperados, 0) AS DECIMAL(5,1)) AS pct_prioritarios_faltantes
    FROM c
    INNER JOIN ${VISIT} v ON v.Visit_id = c.visit_id
    WHERE ${BASE_WHERE}
    ORDER BY v.Visit_start, c.visit_id;
  `);
  return r.recordset;
}

// Composición en góndola (anexo 4), sumada sobre el período filtrado.
// por: marca | fabricante | subcategoria | presentacion (los valores que escribe
// assortmentComplianceRepo en la columna dimension).
async function composicion(f, { por }) {
  if (!DIMENSIONES.includes(por)) throw new Error(`dimension inválida: ${por}`);
  const req = await baseRequest(f);
  req.input('dimension', sql.VarChar(20), por);
  const r = await req.query(`${LATEST}
    SELECT ISNULL(NULLIF(LTRIM(RTRIM(s.valor)), ''), 'Sin dato') AS valor,
           SUM(s.cantidad) AS cantidad
    FROM ${SHARE} s
    INNER JOIN c ON c.compliance_id = s.compliance_id
    INNER JOIN ${VISIT} v ON v.Visit_id = c.visit_id
    WHERE ${BASE_WHERE}
      AND s.dimension = @dimension
    GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(s.valor)), ''), 'Sin dato')
    ORDER BY cantidad DESC, valor;
  `);
  return r.recordset;
}

module.exports = {
  tendencia,
  visitas,
  rankingTiendas,
  rankingCadenas,
  excesoPrioritarios,
  composicion,
  DIMENSIONES,
  AGRUPACIONES: Object.keys(PERIOD_EXPR),
};
