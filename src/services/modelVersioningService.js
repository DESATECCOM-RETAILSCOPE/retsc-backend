// Listado de modelos de detección por categoría (Issue 8.5 — reducido 2026-08-03).
//
// RETIRADO por decisión de jefatura (ver docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md): este
// archivo manejaba un ciclo de re-entrenamiento manual paralelo al flujo real de Custom
// Vision (canRetrain/startRetrain/completeRetrain/approveVersion/rejectVersion/rollback,
// con un gate de métricas vía isWorse() que exigía aprobación humana si el mAP empeoraba).
// Jefatura confirmó que el único flujo válido es el automático de la spec v1.4 (fotos
// aprobadas → sync → umbral → training → publicación, SIN aprobación humana y SIN que las
// métricas bloqueen publicación) — ese ciclo completo fue eliminado de acá:
//   - startRetrain (stub — nunca llamó a Custom Vision real) → lo reemplaza el disparo
//     automático (pasada de cableado posterior, aparte de esta limpieza).
//   - completeRetrain/isWorse (gate de métricas) → eliminado; guardar métricas
//     (aiModelRepo.saveMetrics) sigue existiendo pero solo como persistencia de monitoreo,
//     ya usado directamente por modelTrainingService.js sin ningún gate.
//   - approveVersion/rejectVersion (aprobación humana, approved_by/approved_at) → eliminado
//     por completo, incluida la columna en el script de migración 006 (ver ese archivo).
//   - rollback (reactivar una versión anterior a mano) → eliminado junto con el resto del
//     ciclo manual; no queda un segundo camino paralelo al automático.
//
// Piezas reutilizables que el cableado automático va a necesitar (PRESERVADAS, no se
// tocaron): aiModelRepo.setActiveVersion() (swap de is_active + status), aiModelRepo.
// saveMetrics() (persistencia de métricas), aiModelRepo.getMaxVersion() (para incrementar
// model_version al publicar), y modelTrainingService.js completo (trainProject + polling +
// handleTrainingCompleted) — nada de eso vive ni vivía en este archivo, quedan intactos en
// sus propios módulos para que la pasada de cableado los use.
//
// Lo único que sigue vivo acá: los dos listados de solo lectura que alimentan el menú
// "Modelos de detección" (ADMIN_DTC, F4) — no tienen lógica de negocio propia, son
// pass-through directo a aiModelRepo.

const aiModelRepo = require('../repositories/aiModelRepo');

// GET /api/models — listado global (todas las categorías, todas las versiones).
//
// NOTA (menú por rol, 2026-07-25): aiModelRepo.listAll() hace `SELECT *` sobre
// RETSC_AI_DETECTION_MODELS, así que nunca referencia por nombre las columnas de
// la migración 006 (precision_score/recall_score/mean_ap/metrics_json) — no hay
// "Invalid column name" posible aunque esa migración no esté aplicada, porque
// `SELECT *` simplemente no devuelve columnas que no existen en la tabla real.
async function listAll() {
  return aiModelRepo.listAll();
}

// GET /api/models/category/:categoryId — versiones de una categoría (para la UI de gestión).
async function listVersions(categoryId) {
  return aiModelRepo.listByCategory(categoryId);
}

module.exports = {
  listAll,
  listVersions,
};
