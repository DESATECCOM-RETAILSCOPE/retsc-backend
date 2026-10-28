// Dashboard web (Parte B), pantalla 1: Resumen.
// Rutas en routes/dashboardResumenRoutes.js, bajo /api/dashboard/resumen/*.
//
// KPIs (el mockup muestra 5 a DTC y 3 a los clientes):
//   cumplimiento-promedio  → snapshot de cumplimiento, con variación vs. período anterior
//   productos              → catálogo global; "propios" según el surtido de la empresa
//   cobertura-fotos        → catálogo global, SKUs activos con foto
//   precision-modelo       → solo ADMIN_DTC (la ruta lo exige)
//   lectura-ocr            → solo ADMIN_DTC (la ruta lo exige)
// La tendencia y el top 5 de tiendas del Resumen usan los endpoints de Cumplimiento.

const cumplimientoRepo = require('../repositories/dashboardCumplimientoRepo');
const catalogoRepo     = require('../repositories/dashboardCatalogoRepo');
const modeloRepo       = require('../repositories/dashboardModeloRepo');
const { cardHandler: baseCardHandler, periodoAnterior, round1 } = require('../utils/dashboardCard');

const cardHandler = (opts) => baseCardHandler({ pantalla: 'resumen', ...opts });

const pctDe = (parte, total) => (total > 0 ? round1((parte * 100) / total) : null);
const aPct  = (v) => (v === null || v === undefined ? null : round1(Number(v) * 100));
const promedio = (vals) => {
  const ok = vals.filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v)));
  return ok.length ? ok.reduce((a, v) => a + Number(v), 0) / ok.length : null;
};

// Cumplimiento promedio del período y su variación frente al período anterior de
// la misma duración (el "+2,1 pts" del mockup).
async function fetchCumplimientoPromedio(f) {
  const prev = periodoAnterior(f);
  const [actual, anterior] = await Promise.all([
    cumplimientoRepo.promedioPeriodo(f),
    cumplimientoRepo.promedioPeriodo({ ...f, desde: prev.desde, hastaExclusive: prev.hastaExclusive }),
  ]);
  const a = actual?.cumplimiento_promedio;
  const b = anterior?.cumplimiento_promedio;
  return {
    cumplimiento_promedio:          round1(a),
    visitas:                        Number(actual?.visitas) || 0,
    variacion_pts:                  a != null && b != null ? round1(Number(a) - Number(b)) : null,
    anterior_cumplimiento_promedio: round1(b),
    anterior_visitas:               Number(anterior?.visitas) || 0,
    anterior_desde:                 prev.desde,
    anterior_hasta:                 prev.hasta,
  };
}

async function fetchProductos(f) {
  const p = await catalogoRepo.productos(f);
  return { ...p, pct_propios: pctDe(p.propios, p.total) };
}

async function fetchCobertura(f) {
  const c = await catalogoRepo.coberturaFotos(f);
  return { ...c, pct_cobertura: pctDe(c.con_foto, c.total) };
}

// Precisión de la última iteración. Con una categoría, sus datos completos; sin
// categoría, el promedio de las últimas iteraciones de todas las categorías.
async function fetchPrecisionModelo(f) {
  const rows = await modeloRepo.ultimaIteracion(f.category);
  const unica = rows.length === 1 ? rows[0] : null;
  return {
    precision_pct:     aPct(promedio(rows.map((r) => r.precision_score))),
    recall_pct:        aPct(promedio(rows.map((r) => r.recall_score))),
    map_pct:           aPct(promedio(rows.map((r) => r.mean_ap))),
    categorias:        rows.length,
    categoria:         unica?.categoria ?? null,
    trained_at:        unica?.trained_at ?? null,
    last_publish_name: unica?.last_publish_name ?? null,
    status:            unica?.status ?? null,
  };
}

async function fetchLecturaOcr(f) {
  const o = await modeloRepo.lecturaOcr(f);
  return {
    ...o,
    pct_tasa_lectura:            pctDe(o.con_texto_leido, o.total_detecciones),
    pct_match_sobre_texto_leido: pctDe(o.texto_leido_con_match, o.con_texto_leido),
  };
}

const cumplimientoPromedio = cardHandler({
  tarjeta: 'cumplimiento-promedio',
  fetch:   fetchCumplimientoPromedio,
  columns: [
    { key: 'cumplimiento_promedio',          header: 'Cumplimiento promedio (%)' },
    { key: 'visitas',                        header: 'Visitas' },
    { key: 'variacion_pts',                  header: 'Variación vs. período anterior (pts)' },
    { key: 'anterior_cumplimiento_promedio', header: 'Cumplimiento período anterior (%)' },
    { key: 'anterior_visitas',               header: 'Visitas período anterior' },
    { key: 'anterior_desde',                 header: 'Período anterior desde' },
    { key: 'anterior_hasta',                 header: 'Período anterior hasta' },
  ],
});

const productos = cardHandler({
  tarjeta: 'productos',
  fetch:   fetchProductos,
  columns: [
    { key: 'total',       header: 'Productos registrados' },
    { key: 'propios',     header: 'Propios' },
    { key: 'competencia', header: 'Competencia' },
    { key: 'pct_propios', header: 'Propios (%)' },
  ],
});

const coberturaFotos = cardHandler({
  tarjeta: 'cobertura-fotos',
  fetch:   fetchCobertura,
  columns: [
    { key: 'total',         header: 'SKUs activos' },
    { key: 'con_foto',      header: 'Con foto' },
    { key: 'sin_foto',      header: 'Sin foto' },
    { key: 'pct_cobertura', header: 'Cobertura (%)' },
  ],
});

const precisionModelo = cardHandler({
  tarjeta: 'precision-modelo',
  fetch:   fetchPrecisionModelo,
  columns: [
    { key: 'precision_pct',     header: 'Precisión (%)' },
    { key: 'recall_pct',        header: 'Recall (%)' },
    { key: 'map_pct',           header: 'mAP (%)' },
    { key: 'categorias',        header: 'Categorías incluidas' },
    { key: 'categoria',         header: 'Categoría' },
    { key: 'trained_at',        header: 'Entrenado' },
    { key: 'last_publish_name', header: 'Publicado' },
    { key: 'status',            header: 'Estado' },
  ],
});

const lecturaOcr = cardHandler({
  tarjeta: 'lectura-ocr',
  fetch:   fetchLecturaOcr,
  columns: [
    { key: 'total_detecciones',           header: 'Detecciones' },
    { key: 'con_texto_leido',             header: 'Con texto leído' },
    { key: 'texto_leido_con_match',       header: 'Texto leído con match' },
    { key: 'pct_tasa_lectura',            header: 'Tasa de lectura (%)' },
    { key: 'pct_match_sobre_texto_leido', header: 'Match sobre texto leído (%)' },
  ],
});

module.exports = {
  cumplimientoPromedio,
  productos,
  coberturaFotos,
  precisionModelo,
  lecturaOcr,
  _internals: { fetchCumplimientoPromedio, fetchPrecisionModelo, pctDe },
};
