// Dashboard web (Parte B), pantalla 3: Catálogo & Fotos.
// Rutas en routes/dashboardCatalogoRoutes.js, bajo /api/dashboard/catalogo/*.
// Filtros de la pantalla (según el mockup): empresa (solo DTC) y categoría.
//
//   productos               → SKUs activos por categoría, propios y competencia (anexo 5)
//   fotos-producto          → cobertura de foto por categoría (anexo 6B, KPI principal)
//   fotos-producto-detalle  → estados del log de carga (anexo 6A, soporte)
//   fotos-gondola           → entrenamiento vs. visitas por categoría (anexo 7)

const repo = require('../repositories/dashboardCatalogoRepo');
const { cardHandler: baseCardHandler, round1 } = require('../utils/dashboardCard');

const cardHandler = (opts) => baseCardHandler({ pantalla: 'catalogo', ...opts });
const pctDe = (parte, total) => (Number(total) > 0 ? round1((Number(parte) * 100) / Number(total)) : null);
const nombre = (r) => r.categoria ?? (r.category_id != null ? `Categoría ${r.category_id}` : 'Sin categoría');

const productos = cardHandler({
  tarjeta: 'productos',
  fetch: async (f) => (await repo.productosPorCategoria(f)).map((r) => ({
    ...r,
    categoria:   nombre(r),
    total:       Number(r.total) || 0,
    propios:     Number(r.propios) || 0,
    competencia: Number(r.competencia) || 0,
    pct_propios: pctDe(r.propios, r.total),
  })),
  columns: [
    { key: 'categoria',   header: 'Categoría' },
    { key: 'total',       header: 'SKUs activos' },
    { key: 'propios',     header: 'Propios' },
    { key: 'competencia', header: 'Competencia' },
    { key: 'pct_propios', header: 'Propios (%)' },
  ],
});

const fotosProducto = cardHandler({
  tarjeta: 'fotos-producto',
  fetch: async (f) => (await repo.coberturaPorCategoria(f)).map((r) => {
    const total = Number(r.total) || 0;
    const conFoto = Number(r.con_foto) || 0;
    return { ...r, categoria: nombre(r), total, con_foto: conFoto, sin_foto: total - conFoto, pct_cobertura: pctDe(conFoto, total) };
  }),
  columns: [
    { key: 'categoria',     header: 'Categoría' },
    { key: 'total',         header: 'SKUs activos' },
    { key: 'con_foto',      header: 'Con foto' },
    { key: 'sin_foto',      header: 'Sin foto' },
    { key: 'pct_cobertura', header: 'Cobertura (%)' },
  ],
});

const fotosProductoDetalle = cardHandler({
  tarjeta: 'fotos-producto-detalle',
  fetch: async (f) => (await repo.detalleCarga(f)).map((r) => ({ ...r, cantidad: Number(r.cantidad) || 0 })),
  columns: [
    { key: 'process_status',    header: 'Estado de procesamiento' },
    { key: 'ocr_status',        header: 'Estado OCR' },
    { key: 'embeddings_status', header: 'Estado embeddings' },
    { key: 'cantidad',          header: 'Cantidad' },
  ],
});

const fotosGondola = cardHandler({
  tarjeta: 'fotos-gondola',
  fetch: async (f) => (await repo.fotosGondola(f)).map((r) => ({
    ...r,
    categoria:               nombre(r),
    fotos_entrenamiento:     Number(r.fotos_entrenamiento) || 0,
    entrenamiento_aprobadas: Number(r.entrenamiento_aprobadas) || 0,
    fotos_visita:            Number(r.fotos_visita) || 0,
  })),
  columns: [
    { key: 'categoria',               header: 'Categoría' },
    { key: 'fotos_entrenamiento',     header: 'Fotos de entrenamiento' },
    { key: 'entrenamiento_aprobadas', header: 'Entrenamiento aprobadas' },
    { key: 'fotos_visita',            header: 'Fotos de visita' },
  ],
});

module.exports = { productos, fotosProducto, fotosProductoDetalle, fotosGondola };
