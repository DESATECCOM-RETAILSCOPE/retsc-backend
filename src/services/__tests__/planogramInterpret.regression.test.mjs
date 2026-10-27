// Ciclo 5 · B3 (Fase 8) — detección de formato y lector SPACE_PLANNING.
//
// Muestras reales (NO se suben al repo, son documentos del cliente):
//   LISTA_BANDEJAS → PLANOGRAM_PDF_FIXTURE    o "../Automercado Desodorantes pro.plnx.pdf"
//   SPACE_PLANNING → PLANOGRAM_PDF_FIXTURE_SP o "../desodorantes 6x119 prueba.pdf"
// Si no están, esas pruebas se saltan; las de lógica pura corren siempre.
//
// Correr: node src/services/__tests__/planogramInterpret.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = (p) => require.resolve(path.join(process.cwd(), 'src', p));
const stub = (abs, exports) => { require.cache[abs] = { id: abs, filename: abs, loaded: true, exports }; };
// Sin BD: el catálogo no se usa en estas pruebas (SPACE_PLANNING no consulta SKUs).
stub(SRC('repositories/skuRepo.js'), { findSkusByEans: async () => [] });
const sp = require(SRC('services/planogramSpacePlanningService.js'));

const FIX_A = process.env.PLANOGRAM_PDF_FIXTURE || path.join(process.cwd(), '..', 'Automercado Desodorantes pro.plnx.pdf');
const FIX_B = process.env.PLANOGRAM_PDF_FIXTURE_SP || path.join(process.cwd(), '..', 'desodorantes 6x119 prueba.pdf');
const sinA = !fs.existsSync(FIX_A) && `no está ${FIX_A}`;
const sinB = !fs.existsSync(FIX_B) && `no está ${FIX_B}`;

// PDF mínimo hecho a mano con un texto cualquiera (formato desconocido).
function pdfMinimo(texto) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 20 100 Td (${texto}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

// ── Lógica pura ──────────────────────────────────────────────────────────────
test('unirCodigos: junta el código partido en 2 líneas (misma x, misma letra, justo debajo)', () => {
  const t = (s, x, y, h = 6) => ({ s, x, y, h });
  const c = sp.unirCodigos([t('4609', 25, 100), t('40', 25, 107), t('478325', 80, 100, 7), t('4680', 41, 100), t('90', 41, 107)]);
  assert.deepEqual(c.map((x) => x.codigo).sort(), ['460940', '468090', '478325']);
});

test('unirCodigos: no junta números de otra columna ni de otro tamaño', () => {
  const t = (s, x, y, h = 6) => ({ s, x, y, h });
  const c = sp.unirCodigos([t('4609', 25, 100), t('40', 26.5, 107), t('12', 25, 107, 9)]);
  assert.ok(c.some((x) => x.codigo === '4609'), 'el "40" está corrido en x y el "12" tiene otra letra');
});

test('agruparFilas: agrupa por altura, fila 1 = arriba, cada fila de izquierda a derecha', () => {
  const c = (codigo, x, y) => ({ codigo, x, y, h: 7 });
  const filas = sp.agruparFilas([c('B2', 50, 300), c('A2', 60, 101), c('A1', 10, 100), c('B1', 5, 302)]);
  assert.deepEqual(filas.map((f) => f.items.map((i) => i.codigo)), [['A1', 'A2'], ['B1', 'B2']]);
});

test('leerEncabezado: título, archivo .psa y fecha de impresión', () => {
  const h = sp.leerEncabezado([{ s: 'Planogram:  CD 1000+ 5X8 122 - Front View' }, { s: 'File: C:\\Users\\X\\LISTOS\\A 6x7 119.psa' }, { s: 'Printed:  22/10/2026' }]);
  assert.deepEqual(h, { titulos: ['CD 1000+ 5X8 122'], archivo: 'A 6x7 119.psa', fecha: '2026-10-22' });
});

// ── Detección de formato ─────────────────────────────────────────────────────
test('detectarFormato: PDF que no es de ningún formato conocido → null; interpretarPdf → 422', async () => {
  const { detectarFormato, interpretarPdf } = require(SRC('services/planogramInterpretService.js'));
  const pdf = pdfMinimo('Factura 12345');
  assert.equal(await detectarFormato(pdf), null);
  await assert.rejects(interpretarPdf({ buffer: pdf }), (e) => e.statusCode === 422 && e.errorCode === 'ERR_FORMATO_PLANOGRAMA_DESCONOCIDO');
});

test('detectarFormato: Automercado → LISTA_BANDEJAS', { skip: sinA }, async () => {
  const { detectarFormato } = require(SRC('services/planogramInterpretService.js'));
  assert.equal(await detectarFormato(fs.readFileSync(FIX_A)), 'LISTA_BANDEJAS');
});

test('detectarFormato: Space Planning → SPACE_PLANNING', { skip: sinB }, async () => {
  const { detectarFormato } = require(SRC('services/planogramInterpretService.js'));
  assert.equal(await detectarFormato(fs.readFileSync(FIX_B)), 'SPACE_PLANNING');
});

// ── Lector SPACE_PLANNING con la muestra real ────────────────────────────────
test('SPACE_PLANNING real: 292 posiciones, 2 muebles × 8 filas, códigos de 6 dígitos, orden por x', { skip: sinB }, async () => {
  const p = await sp.construirPropuestaSpacePlanning({ buffer: fs.readFileSync(FIX_B), planogramSeq: 9 });
  assert.equal(p.formato, 'SPACE_PLANNING');
  assert.equal(p.planogram_seq, 9);
  assert.equal(p.resumen.posiciones, 292);
  assert.equal(p.resumen.codigos_repetidos, 0);
  assert.deepEqual(p.fuente, { tipo: 'PDF', archivo: 'A 6x7 119.psa', fecha: '2026-10-22', titulos: ['CD 1000+ 5X8 122'] });
  assert.deepEqual(p.muebles.map((m) => m.shelfunit_id), [1, 2]);
  assert.ok(p.muebles.every((m) => m.niveles.length === 8));
  const todas = p.muebles.flatMap((m) => m.niveles.flatMap((n) => n.posiciones));
  assert.ok(todas.every((x) => /^\d{6}$/.test(x.codigo_cadena)));
  assert.ok(todas.every((x) => x.sku_id === null && x.match_detalle === 'CODIGO_CADENA_SIN_MAPEO' && x.estado === 'REVISAR'));
  const fila1 = p.muebles[0].niveles[0];
  assert.equal(fila1.shelflevel_id, 1);
  assert.deepEqual(fila1.posiciones.slice(0, 5).map((x) => x.codigo_cadena), ['460940', '468090', '439010', '478325', '478324']);
  assert.deepEqual(fila1.posiciones.map((x) => x.shelfcolumn_id), fila1.posiciones.map((_, i) => i + 1));
  // Fila 1 completa (los 2 muebles) = 35 productos; el mueble 2 arranca en 478353.
  assert.equal(p.muebles[0].niveles[0].posiciones.length + p.muebles[1].niveles[0].posiciones.length, 35);
  assert.equal(p.muebles[1].niveles[0].posiciones[0].codigo_cadena, '478353');
  // Cajas dentro de la página y de izquierda a derecha.
  for (const m of p.muebles) for (const n of m.niveles) {
    n.posiciones.forEach((x, i) => {
      assert.ok(x.bbox.x >= 0 && x.bbox.x + x.bbox.w <= 1.001 && x.bbox.h > 0);
      if (i) assert.ok(x.bbox.x > n.posiciones[i - 1].bbox.x);
    });
  }
  assert.ok(p.advertencias.some((a) => /mapeo código de cadena → EAN/.test(a)));
  assert.ok(p.advertencias.some((a) => /No hay mapeo de códigos para esta cadena/.test(a)));
  assert.equal(p.resumen.sin_sku, 292);
});

test('interpretarPdf real SPACE_PLANNING: devuelve formato, propuesta y dibujo PNG (sin IA ni BD)', { skip: sinB }, async () => {
  const { interpretarPdf } = require(SRC('services/planogramInterpretService.js'));
  const r = await interpretarPdf({ buffer: fs.readFileSync(FIX_B), planogramSeq: 3, flowDirection: 'IZQ_DER' });
  assert.equal(r.formato, 'SPACE_PLANNING');
  assert.equal(r.propuesta.flow_direction, 'IZQ_DER');
  assert.equal(r.dibujoPng.subarray(1, 4).toString(), 'PNG');
  assert.ok(r.propuesta.dibujo.width > 0);
});
