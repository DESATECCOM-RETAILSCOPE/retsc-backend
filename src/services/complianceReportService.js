// Genera el PDF del reporte "Cumplimiento de Surtido" — resumen tabular (no replica los
// gráficos de pastel del mobile, solo listas con porcentajes) a partir de la misma data que
// devuelve assortmentComplianceService.getCompliance(). Se arma en memoria y se stremea
// directo a la response (ver reportController.js) — no se persiste a disco ni a blob.

const PDFDocument = require('pdfkit');

const DIMENSION_LABELS = {
  marca:        'Por marca',
  subcategoria: 'Por subcategoría',
  presentacion: 'Por presentación',
  fabricante:   'Por fabricante',
};
const DIMENSION_ORDER = ['marca', 'subcategoria', 'presentacion', 'fabricante'];

function complianceLabel(pct) {
  if (pct >= 80) return 'Bueno';
  if (pct >= 50) return 'Regular';
  return 'Necesita atención';
}

// Devuelve el PDFDocument ya con todo el contenido escrito (todavía sin `.end()` llamado
// por el caller — reportController hace doc.pipe(res) antes de terminarlo para poder
// streamear sin cargar el PDF completo en memoria).
function buildComplianceReportDoc({ compliance, share, faltantes, enExceso, retailerName, categoryDsc }) {
  const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });

  const pct = Number(compliance.cumplimiento_pct) || 0;
  const totalExceso = (compliance.en_exceso_fuera_surtido || 0) + (compliance.en_exceso_no_autorizado || 0);
  const fecha = compliance.calculado_en ? new Date(compliance.calculado_en).toLocaleDateString('es-CR') : '';

  doc.fontSize(20).fillColor('#000').text('Cumplimiento de surtido');
  doc.fontSize(11).fillColor('#666').text(`${categoryDsc}  ·  ${retailerName}  ·  ${fecha}`);
  doc.moveDown();

  doc.fillColor('#000').fontSize(16).text(`Cumplimiento: ${Math.round(pct)}% (${complianceLabel(pct)})`);
  doc.fontSize(11);
  doc.text(`Productos esperados: ${compliance.productos_esperados}`);
  doc.text(`Productos detectados: ${compliance.productos_detectados}`);
  doc.text(`Faltantes: ${compliance.faltantes}`);
  doc.text(`En exceso: ${totalExceso}`);
  if (compliance.prioritarios_faltantes > 0) {
    doc.fillColor('#9a6a00').text(`Prioritarios faltantes (reponer hoy): ${compliance.prioritarios_faltantes}`);
    doc.fillColor('#000');
  }
  doc.moveDown();

  doc.fontSize(14).text('Composición en góndola', { underline: true });
  doc.moveDown(0.3);
  DIMENSION_ORDER.forEach((dim) => {
    const rows = share.filter((s) => s.dimension === dim).sort((a, b) => b.cantidad - a.cantidad);
    if (!rows.length) return;
    const total = rows.reduce((sum, r) => sum + r.cantidad, 0) || 1;
    doc.fontSize(12).text(DIMENSION_LABELS[dim]);
    doc.fontSize(10);
    rows.slice(0, 8).forEach((r) => {
      const rowPct = Math.round((r.cantidad / total) * 100);
      doc.text(`   ${r.valor || 'Sin dato'}: ${rowPct}% (${r.cantidad})`);
    });
    doc.moveDown(0.4);
  });

  doc.addPage();
  doc.fontSize(14).text('Detalle', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);

  const detalle = [
    ...faltantes.map((p) => ({ ...p, estado: 'FALTANTE' })),
    ...enExceso.map((p) => ({ ...p, estado: 'EN EXCESO' })),
  ];

  if (detalle.length === 0) {
    doc.text('Sin faltantes ni excesos — surtido completo.');
  } else {
    detalle.forEach((p) => {
      const marca = p.Brand || 'Sin marca';
      const motivo = p.motivo ? (p.motivo === 'FUERA_DE_SURTIDO' ? ' · fuera de surtido' : ' · no autorizado') : '';
      const prioridad = p.es_prioritario ? ' [PRIORITARIO]' : '';
      if (doc.y > 760) doc.addPage();
      doc.text(`[${p.estado}] ${p.Product_dsc}${prioridad} — ${marca}${motivo}`);
    });
  }

  return doc;
}

module.exports = { buildComplianceReportDoc };
