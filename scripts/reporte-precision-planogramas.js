// Ciclo 5 · B5 (Fase 9) — Reporte de precisión de la lectura automática de planogramas.
//
// Por planograma compara lo que LEYÓ el sistema (propuesta_original) contra lo que quedó después
// de la revisión humana (propuesta) — ver planogramReviewService.calcularPrecision — y reporta lo
// que pide el plan (B5):
//   · posiciones totales, % que no hubo que corregir, % con EAN exacto, % sin identificar;
//   · ningún SKU propuesto por el sistema que no venga de un código leído (debe dar 0);
//   · si se aprobó: filas grabadas en RETSC_OP_PLANOGRAMDET y planogramas anteriores inactivados.
// Un planograma sin revisión guardada sale "sin revisar" (todavía no hay correcciones que medir).
//
// Uso (desde la raíz de Back End, con el .env del ambiente — SOLO LECTURA):
//   node scripts/reporte-precision-planogramas.js 12 15 18 --salida ../B0/reporte
//   node scripts/reporte-precision-planogramas.js --archivos a.propuesta.json b.propuesta.json   (sin BD: JSON descargados)
// Salida: reporte-precision.md y reporte-precision.csv en --salida (default: ./reportes).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { calcularPrecision } = require('../src/services/planogramReviewService');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const salida = opt('--salida') || 'reportes';
const modoArchivos = args.includes('--archivos');
const valores = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--salida');
if (!valores.length) {
  console.error('Uso: node scripts/reporte-precision-planogramas.js <seq> [<seq>…] [--salida <carpeta>]\n     node scripts/reporte-precision-planogramas.js --archivos <propuesta.json>… [--salida <carpeta>]');
  process.exit(1);
}

const CONTAINER = process.env.AZURE_PLANOGRAM_CONTAINER || 'enterprise-planograms';
const f1 = (v) => (v == null ? '—' : `${v} %`);

function fila(nombre, doc, extra = {}) {
  if (!doc?.propuesta) return { planograma: nombre, estado: doc?.estado ?? 'SIN LECTURA', ...extra };
  const revisado = Boolean(doc.propuesta_original);
  const m = calcularPrecision(doc.propuesta_original ?? doc.propuesta, doc.propuesta);
  return {
    planograma: nombre,
    formato: doc.formato ?? doc.propuesta.formato ?? '—',
    archivo: doc.propuesta.fuente?.archivo ?? '—',
    estado: doc.aprobacion ? 'APROBADO' : revisado ? 'REVISADO' : 'SIN REVISAR',
    posiciones: m.posiciones_leidas,
    pct_sin_corregir: revisado || doc.aprobacion ? m.pct_sin_corregir : null,
    pct_ean_exacto: m.pct_ean_exacto,
    pct_sin_identificar: m.pct_sin_identificar,
    sku_cambiado: m.correcciones.sku_cambiado,
    orden: m.correcciones.orden,
    otra_fila: m.correcciones.otra_fila,
    frentes: m.correcciones.frentes,
    borradas: m.correcciones.eliminadas,
    agregadas: m.agregadas,
    sku_sin_codigo: m.sku_propuesto_sin_codigo,
    filas_aprobadas: doc.aprobacion?.filas ?? null,
    inactivados: (doc.aprobacion?.inactivados ?? []).map((x) => x.Planogram_seq).join(' ') || null,
    ...extra,
  };
}

async function cargarDesdeBase(seqs) {
  const planogramRepo = require('../src/repositories/planogramRepo');
  const blob = require('../src/services/blobStorageService');
  const filas = [];
  const encontrados = await planogramRepo.findBySeqs(seqs);
  for (const seq of seqs.map(Number)) {
    const p = encontrados.find((x) => Number(x.Planogram_seq) === seq);
    if (!p) { filas.push({ planograma: `#${seq}`, estado: 'NO EXISTE' }); continue; }
    const extra = { status_bd: p.Status, empresa: p.Enterprise_id, categoria: p.Category_dsc, tienda: p.Retailer_id == null ? `Todas (${p.Supermarketchain ?? p.Supermarketchain_id})` : p.Retailer_dsc };
    if (!/\.pdf$/i.test(p.URL_picture || '')) { filas.push({ planograma: `#${seq}`, estado: 'IMAGEN (sin lectura)', ...extra }); continue; }
    try {
      const buf = await blob.downloadFromContainer({ containerName: CONTAINER, blobPath: `${p.URL_picture}.propuesta.json` });
      const doc = JSON.parse(buf.toString('utf8'));
      const r = fila(`#${seq}`, doc, extra);
      if (p.Status === 'ACTIVO' || p.Status === 'INACTIVO') r.filas_en_bd = (await planogramRepo.listDetail(seq)).length;
      filas.push(r);
    } catch (e) {
      filas.push({ planograma: `#${seq}`, estado: `SIN LECTURA (${e.code || e.message})`, ...extra });
    }
  }
  return filas;
}

function aMarkdown(filas) {
  const tot = filas.filter((f) => f.posiciones);
  const sum = (k) => tot.reduce((s, f) => s + (f[k] ?? 0), 0);
  const lineas = [
    '# Reporte de precisión — lectura automática de planogramas (ciclo 5, B5)',
    '',
    `Generado: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${filas.length} planograma(s)`,
    '',
    '| Planograma | Formato | Estado | Posiciones | Sin corregir | EAN exacto | Sin identificar | SKU cambiado | Orden | Otra fila | Frentes | Borradas | Agregadas | SKU sin código | Filas aprobadas | Inactivó |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...filas.map((f) => `| ${f.planograma}${f.tienda ? ` · ${f.tienda}` : ''} | ${f.formato ?? '—'} | ${f.estado} | ${f.posiciones ?? '—'} | ${f1(f.pct_sin_corregir)} | ${f1(f.pct_ean_exacto)} | ${f1(f.pct_sin_identificar)} | ${f.sku_cambiado ?? '—'} | ${f.orden ?? '—'} | ${f.otra_fila ?? '—'} | ${f.frentes ?? '—'} | ${f.borradas ?? '—'} | ${f.agregadas ?? '—'} | ${f.sku_sin_codigo ?? '—'} | ${f.filas_aprobadas ?? '—'}${f.filas_en_bd != null ? ` (BD: ${f.filas_en_bd})` : ''} | ${f.inactivados ?? '—'} |`),
    '',
    `**Total:** ${sum('posiciones')} posiciones leídas · ${sum('sku_cambiado')} SKU cambiados · ${sum('orden')} reordenados · ${sum('otra_fila')} movidos de fila · ${sum('borradas')} borrados · ${sum('agregadas')} agregados.`,
    '',
    '**Cómo leerlo**',
    '- *Sin corregir*: posiciones leídas que llegaron igual a la versión revisada (mismo SKU, misma fila, mismo orden relativo y mismos frentes). Solo se calcula si el planograma se revisó o aprobó.',
    '- *Orden*: posiciones que hubo que mover dentro de su fila (agregar un producto al inicio NO cuenta como error de los demás).',
    '- *SKU sin código*: SKU que el sistema propuso sin venir de un código leído. Debe ser **0** (criterio B5).',
    '- *Inactivó*: planogramas ACTIVOS del mismo alcance que pasaron a INACTIVO al aprobar (criterio B5).',
  ];
  return lineas.join('\n') + '\n';
}

function aCsv(filas) {
  const cols = ['planograma', 'tienda', 'categoria', 'formato', 'archivo', 'estado', 'status_bd', 'posiciones', 'pct_sin_corregir', 'pct_ean_exacto', 'pct_sin_identificar', 'sku_cambiado', 'orden', 'otra_fila', 'frentes', 'borradas', 'agregadas', 'sku_sin_codigo', 'filas_aprobadas', 'filas_en_bd', 'inactivados'];
  const esc = (v) => (v == null ? '' : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...filas.map((f) => cols.map((c) => esc(f[c])).join(','))].join('\n') + '\n';
}

(async () => {
  const filas = modoArchivos
    ? valores.map((a) => fila(path.basename(a), JSON.parse(fs.readFileSync(a, 'utf8'))))
    : await cargarDesdeBase(valores);
  fs.mkdirSync(salida, { recursive: true });
  const md = aMarkdown(filas);
  fs.writeFileSync(path.join(salida, 'reporte-precision.md'), md);
  fs.writeFileSync(path.join(salida, 'reporte-precision.csv'), aCsv(filas));
  console.log(md);
  console.log(`→ ${path.join(salida, 'reporte-precision.md')}\n→ ${path.join(salida, 'reporte-precision.csv')}`);
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
