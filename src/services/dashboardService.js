// Servicio del dashboard (Issue B7, + follow-up de tendencias/categoría/precisión IA/
// actividad reciente). Resuelve el SCOPE (global vs. por empresa) según el rol del usuario
// logueado y delega el cálculo real a dashboardRepo.js.

const dashboardRepo = require('../repositories/dashboardRepo');
const { ROLES, normalizeRole } = require('../config/roles');

// ADMIN_DTC ve la plataforma completa (enterpriseId=null → conteo global en el repo).
// ADMIN y GERENCIA quedan escopeados a su propia empresa (req.user.enterpriseId).
//
// NOTA sobre GERENCIA: el pedido original decía "Supervisor", pero ese rol está
// desactivado en el catálogo (0 usuarios, ver scripts/sync-roles-with-qa.js) — el rol de
// gerencia activo hoy es GERENCIA. Se asume que es el mismo concepto; CONFIRMAR con María.
// GERENCIA se trata igual que ADMIN acá (scope = su propia empresa) porque el JWT no
// distingue ningún otro scope posible para ese rol — no hay un concepto de "región" o
// "grupo de empresas" en el token hoy.
function resolveScope(user) {
  const isDtc = normalizeRole(user?.roleName) === ROLES.ADMIN_DTC;
  return { enterpriseId: isDtc ? null : user.enterpriseId };
}

const TREND_LOOKBACK_DAYS = 30;
const SERIES_LIMIT = 8;

// null si no hay referencia o si es 0 (no se puede calcular % contra cero) — el frontend
// oculta la flecha de tendencia cuando deltaPct es null, no hay que inventar un número.
function computeDeltaPct(current, reference) {
  if (reference == null || reference === 0) return null;
  return Math.round(((current - reference) / reference) * 1000) / 10;
}

// Serie de valores de un campo a partir de las filas de snapshot (ascendente, ya vienen así
// de dashboardRepo.getSnapshotSeries). Si no hay NINGÚN snapshot persistido todavía (tabla
// recién creada, o migración 008 no aplicada aún), cae a un array de 1 elemento con el valor
// de HOY recién calculado — sigue siendo un dato real, solo que sin historial detrás.
function buildSeries(snapshotRows, field, currentValue) {
  const values = snapshotRows.map(r => r[field]).filter(v => v != null);
  if (values.length > 0) return values;
  return currentValue != null ? [currentValue] : [];
}

function formatDate(d) {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

async function getDashboard(user) {
  const scope = resolveScope(user);

  const [productCards, productPhotos, activeAssortments, analysesDone, avgPrecisionRaw] = await Promise.all([
    dashboardRepo.countProductCards(scope),
    dashboardRepo.countProductPhotos(scope),
    dashboardRepo.countActiveAssortments(scope),
    dashboardRepo.countAnalysesDone(scope),
    dashboardRepo.getModelPrecisionAvg(scope),
  ]);

  // precision_score se guarda como fracción [0,1] en RETSC_AI_DETECTION_MODELS —
  // avgPct siempre en porcentaje (×100), 1 decimal.
  const avgModelPrecisionPct = avgPrecisionRaw != null ? Math.round(avgPrecisionRaw * 1000) / 10 : null;

  // Guarda el snapshot de HOY con lo que se acaba de calcular. Nunca lanza (ver
  // dashboardRepo.upsertSnapshotToday) — si la tabla de snapshots todavía no existe
  // (migración 008 pendiente), esto se degrada solo sin afectar el resto de la respuesta.
  await dashboardRepo.upsertSnapshotToday({
    enterpriseId: scope.enterpriseId,
    productCards,
    productPhotos,
    activeAssortments,
    analysesDone,
    avgModelPrecisionPct,
  });

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - TREND_LOOKBACK_DAYS);

  const [series, reference, categoryRows, activitySources] = await Promise.all([
    dashboardRepo.getSnapshotSeries({ enterpriseId: scope.enterpriseId, limit: SERIES_LIMIT }),
    dashboardRepo.getReferenceSnapshot({ enterpriseId: scope.enterpriseId, cutoffDate }),
    dashboardRepo.getProductsByCategory(scope),
    dashboardRepo.getRecentActivitySources(scope),
  ]);

  const trends = {
    productCards: {
      deltaPct: computeDeltaPct(productCards, reference?.product_cards),
      series: buildSeries(series, 'product_cards', productCards),
    },
    productPhotos: {
      deltaPct: computeDeltaPct(productPhotos, reference?.product_photos),
      series: buildSeries(series, 'product_photos', productPhotos),
    },
    activeAssortments: {
      deltaPct: computeDeltaPct(activeAssortments, reference?.active_assortments),
      series: buildSeries(series, 'active_assortments', activeAssortments),
    },
    analysesDone: {
      deltaPct: computeDeltaPct(analysesDone, reference?.analyses_done),
      series: buildSeries(series, 'analyses_done', analysesDone),
    },
  };

  // modelPrecision SIEMPRE viaja como objeto completo (avgPct/deltaPct/series), aunque todo
  // venga null/[] — el frontend distingue "el panel existe pero sin datos" de "no implementado".
  const modelPrecision = {
    avgPct: avgModelPrecisionPct,
    deltaPct: avgModelPrecisionPct != null ? computeDeltaPct(avgModelPrecisionPct, reference?.avg_model_precision_pct) : null,
    series: series
      .filter(r => r.avg_model_precision_pct != null)
      .map(r => ({ date: formatDate(r.snapshot_date), value: Math.round(r.avg_model_precision_pct * 10) / 10 })),
  };

  const recentActivity = activitySources
    .filter(a => a.occurredAt)
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
    .slice(0, 10);

  return {
    productCards,
    productPhotos,
    activeAssortments,
    analysesDone,
    trends,
    productsByCategory: categoryRows.map(r => ({
      categoryId: r.categoryId,
      categoryDsc: r.categoryDsc,
      count: r.count,
    })),
    modelPrecision,
    recentActivity,
  };
}

module.exports = { getDashboard };
