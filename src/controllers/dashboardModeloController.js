// Dashboard web (Parte B), pantalla 4: Modelo IA & OCR. Solo ADMIN_DTC (la ruta lo exige).
// Rutas en routes/dashboardModeloRoutes.js, bajo /api/dashboard/modelo/*.
// Filtro de la pantalla (según el mockup): solo categoría.
//
//   iteracion → última iteración por categoría (anexo 8): entrenado y publicado juntos,
//               métricas en % y un estado "Revisar" si no llega a los mínimos
//   ocr       → OCR nivel 1 (anexo 9) sobre todas las empresas y todo el período
// El OCR nivel 2 está fuera de alcance del ciclo: la web muestra "Próximamente".

const repo = require('../repositories/dashboardModeloRepo');
const { cardHandler: baseCardHandler, round1 } = require('../utils/dashboardCard');

const cardHandler = (opts) => baseCardHandler({ pantalla: 'modelo', ...opts });

// Mínimos recomendados para un modelo, los mismos que usa
// services/modelTrainingService.js (MIN_PRECISION y MIN_RECALL).
const MIN_PRECISION = 0.80;
const MIN_RECALL    = 0.75;

const aPct  = (v) => (v === null || v === undefined ? null : round1(Number(v) * 100));
const pctDe = (parte, total) => (Number(total) > 0 ? round1((Number(parte) * 100) / Number(total)) : null);

function estadoModelo(r) {
  const p = r.precision_score == null ? null : Number(r.precision_score);
  const rc = r.recall_score == null ? null : Number(r.recall_score);
  if (p == null || rc == null) return 'Sin métricas';
  if (p < MIN_PRECISION || rc < MIN_RECALL) return 'Revisar';
  return r.is_active ? 'Activo' : 'Inactivo';
}

const iteracion = cardHandler({
  tarjeta: 'iteracion',
  fetch: async (f) => (await repo.ultimaIteracion(f.category)).map((r) => ({
    category_id:       r.category_id,
    categoria:         r.categoria ?? `Categoría ${r.category_id}`,
    model_name:        r.model_name ?? null,
    model_version:     r.model_version ?? null,
    trained_at:        r.trained_at ?? null,
    last_publish_name: r.last_publish_name ?? null,
    precision_pct:     aPct(r.precision_score),
    recall_pct:        aPct(r.recall_score),
    map_pct:           aPct(r.mean_ap),
    status:            r.status ?? null,
    estado:            estadoModelo(r),
  })),
  columns: [
    { key: 'categoria',         header: 'Categoría' },
    { key: 'model_version',     header: 'Versión' },
    { key: 'trained_at',        header: 'Entrenado' },
    { key: 'last_publish_name', header: 'Publicado' },
    { key: 'precision_pct',     header: 'Precisión (%)' },
    { key: 'recall_pct',        header: 'Recall (%)' },
    { key: 'map_pct',           header: 'mAP (%)' },
    { key: 'status',            header: 'Status' },
    { key: 'estado',            header: 'Estado' },
  ],
});

const ocr = cardHandler({
  tarjeta: 'ocr-nivel-1',
  fetch: async (f) => {
    const o = await repo.lecturaOcr({ enterpriseId: null, category: f.category, desde: null, hastaExclusive: null });
    const sinMatch = o.con_texto_leido - o.texto_leido_con_match;
    return {
      ...o,
      texto_leido_sin_match:       sinMatch,
      pct_tasa_lectura:            pctDe(o.con_texto_leido, o.total_detecciones),
      pct_match_sobre_texto_leido: pctDe(o.texto_leido_con_match, o.con_texto_leido),
      pct_sin_match:               pctDe(sinMatch, o.con_texto_leido),
    };
  },
  columns: [
    { key: 'total_detecciones',           header: 'Detecciones' },
    { key: 'con_texto_leido',             header: 'Con texto leído' },
    { key: 'texto_leido_con_match',       header: 'Texto leído con match' },
    { key: 'texto_leido_sin_match',       header: 'Texto leído sin match' },
    { key: 'pct_tasa_lectura',            header: 'Tasa de lectura (%)' },
    { key: 'pct_match_sobre_texto_leido', header: 'Match sobre texto leído (%)' },
    { key: 'pct_sin_match',               header: 'Sin match sobre texto leído (%)' },
  ],
});

module.exports = { iteracion, ocr, _internals: { estadoModelo } };
