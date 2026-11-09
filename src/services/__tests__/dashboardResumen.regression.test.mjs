// Dashboard web (Parte B), pantalla 1: Resumen.
//   · cumplimiento promedio con variación frente al período anterior de igual duración
//   · productos y cobertura: porcentajes, y null sin dividir por cero
//   · precisión: métricas de 0 a 1 pasadas a %; una categoría → detalle; varias → promedio
//   · lectura OCR: tasa y match sobre texto leído
//   · KPI en CSV: una sola fila; cliente que pide otra empresa → 403
//   · periodoAnterior: mismo largo, termina el día antes de "desde"
// Sin BD: repositorios simulados vía require.cache.
// Correr: node src/services/__tests__/dashboardResumen.regression.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');
const stub = (p, e) => { const id = require.resolve(path.join(SRC, p)); require.cache[id] = { id, filename: id, loaded: true, exports: e }; };

let calls, modelos, productosRow, coberturaRow, ocrRow, promedios;
stub('repositories/dashboardCumplimientoRepo.js', {
  promedioPeriodo: async (f) => { calls.push(['promedio', f.desde, f.hastaExclusive]); return promedios[f.desde] ?? { visitas: 0, cumplimiento_promedio: null }; },
});
stub('repositories/dashboardCatalogoRepo.js', {
  productos: async () => productosRow,
  coberturaFotos: async () => coberturaRow,
});
stub('repositories/dashboardModeloRepo.js', {
  ultimaIteracion: async (cat) => { calls.push(['modelo', cat]); return modelos; },
  lecturaOcr: async () => ocrRow,
});
stub('repositories/enterpriseRepo.js', { findById: async () => ({ Enterprise_dsc: 'Unilever C.A.' }) });

const c = require(path.join(SRC, 'controllers', 'dashboardResumenController.js'));
const { periodoAnterior } = require(path.join(SRC, 'utils', 'dashboardCard.js'));

const cliente = { userId: 59, enterpriseId: 35, roleName: 'ADMIN' };
const res = () => ({ code: 200, body: null, headers: {}, chunks: [],
  status(x) { this.code = x; return this; }, json(b) { this.body = b; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, write(s) { this.chunks.push(s); }, end() {} });
const call = async (h, user, query) => { const r = res(); await h({ user, query }, r); return r; };

beforeEach(() => {
  calls = [];
  promedios = {
    '2026-07-01': { visitas: 25, cumplimiento_promedio: 4.0 },
  };
  modelos = [{ category_id: 2, categoria: 'DESODORANTES CORPORALES', precision_score: 0.886, recall_score: 0.729, mean_ap: 0.893,
    trained_at: '2026-09-12T00:00:00.000Z', last_publish_name: 'Iteration7', status: 'PUBLISHED' }];
  productosRow = { total: 201, propios: 83, competencia: 118 };
  coberturaRow = { total: 201, con_foto: 192, sin_foto: 9 };
  ocrRow = { total_detecciones: 400, con_texto_leido: 300, texto_leido_con_match: 120 };
});

test('periodoAnterior: misma duración, termina el día antes', () => {
  assert.deepEqual(periodoAnterior({ desde: '2026-07-01', hastaExclusive: '2026-10-01' }),
    { desde: '2026-03-31', hasta: '2026-06-30', hastaExclusive: '2026-07-01' });
  assert.deepEqual(periodoAnterior({ desde: '2026-09-28', hastaExclusive: '2026-10-28' }),
    { desde: '2026-08-29', hasta: '2026-09-27', hastaExclusive: '2026-09-28' });
});

test('cumplimiento promedio: valor actual, anterior y variación en puntos', async () => {
  promedios['2026-03-31'] = { visitas: 10, cumplimiento_promedio: 1.9 }; // 92 días antes
  const r = await call(c.cumplimientoPromedio, cliente, { desde: '2026-07-01', hasta: '2026-09-30' });
  assert.equal(r.code, 200);
  const d = r.body.data;
  assert.equal(d.cumplimiento_promedio, 4.0);
  assert.equal(d.visitas, 25);
  assert.equal(d.anterior_cumplimiento_promedio, 1.9);
  assert.equal(d.variacion_pts, 2.1);
  assert.equal(d.anterior_desde, '2026-03-31');
  assert.equal(d.anterior_hasta, '2026-06-30');
  assert.deepEqual(calls.map((x) => x[1]).sort(), ['2026-03-31', '2026-07-01']);
});

test('cumplimiento promedio: sin datos en el período anterior → variación null', async () => {
  const r = await call(c.cumplimientoPromedio, cliente, { desde: '2026-07-01', hasta: '2026-09-30' });
  assert.equal(r.body.data.variacion_pts, null);
});

test('productos y cobertura: porcentajes', async () => {
  assert.equal((await call(c.productos, cliente, {})).body.data.pct_propios, 41.3);
  assert.equal((await call(c.coberturaFotos, cliente, {})).body.data.pct_cobertura, 95.5);
});

test('productos y cobertura sin SKUs: porcentaje null', async () => {
  productosRow = { total: 0, propios: 0, competencia: 0 };
  coberturaRow = { total: 0, con_foto: 0, sin_foto: 0 };
  assert.equal((await call(c.productos, cliente, {})).body.data.pct_propios, null);
  assert.equal((await call(c.coberturaFotos, cliente, {})).body.data.pct_cobertura, null);
});

test('precisión: una categoría → % y detalle de la última iteración', async () => {
  const d = (await call(c.precisionModelo, cliente, { category: '2' })).body.data;
  assert.deepEqual([d.precision_pct, d.recall_pct, d.map_pct, d.categorias], [88.6, 72.9, 89.3, 1]);
  assert.equal(d.last_publish_name, 'Iteration7');
  assert.deepEqual(calls.find((x) => x[0] === 'modelo'), ['modelo', 2]);
});

test('precisión: varias categorías → promedio, sin detalle', async () => {
  modelos = [{ precision_score: 0.9 }, { precision_score: 0.8 }, { precision_score: null }];
  const d = (await call(c.precisionModelo, cliente, {})).body.data;
  assert.equal(d.precision_pct, 85);
  assert.equal(d.categorias, 3);
  assert.equal(d.last_publish_name, null);
});

test('precisión sin modelos: null', async () => {
  modelos = [];
  assert.equal((await call(c.precisionModelo, cliente, {})).body.data.precision_pct, null);
});

test('lectura OCR: tasa y match sobre texto leído', async () => {
  const d = (await call(c.lecturaOcr, cliente, {})).body.data;
  assert.equal(d.pct_tasa_lectura, 75);
  assert.equal(d.pct_match_sobre_texto_leido, 40);
});

test('KPI en CSV: una fila con nombre de archivo de la tarjeta', async () => {
  const r = await call(c.productos, cliente, { export: 'csv', desde: '2026-07-01', hasta: '2026-09-30' });
  assert.match(r.headers['content-disposition'], /resumen_productos_unilever_2026-07-01_2026-09-30\.csv/);
  assert.equal(r.chunks.join(''), '\uFEFFProductos registrados;Propios;Competencia;Propios (%)\r\n201;83;118;41,3\r\n');
});

test('cliente que pide otra empresa → 403', async () => {
  assert.equal((await call(c.productos, cliente, { enterpriseId: '36' })).code, 403);
});
