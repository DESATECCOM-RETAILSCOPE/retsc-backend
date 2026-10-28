// Dashboard web (Parte B), pantalla 3: Catálogo & Fotos.
//   · productos y cobertura por categoría con porcentajes (null sin dividir por cero)
//   · categoría sin nombre → "Categoría N"
//   · fotos de góndola: entrenamiento y visitas por separado
//   · filtros de la pantalla: empresa y categoría; ignora cadena y fechas
//   · CSV con el nombre de la pantalla, sin fechas; cliente que pide otra empresa → 403
// Sin BD: repositorio simulado vía require.cache.
// Correr: node src/services/__tests__/dashboardCatalogo.regression.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');
const stub = (p, e) => { const id = require.resolve(path.join(SRC, p)); require.cache[id] = { id, filename: id, loaded: true, exports: e }; };

let calls;
stub('repositories/dashboardCatalogoRepo.js', {
  productosPorCategoria: async (f) => { calls.push(f); return [
    { category_id: 2, categoria: 'DESODORANTES CORPORALES', total: 201, propios: 83, competencia: 118 },
    { category_id: 9, categoria: null, total: 0, propios: 0, competencia: 0 },
  ]; },
  coberturaPorCategoria: async () => [{ category_id: 2, categoria: 'DESODORANTES CORPORALES', total: 201, con_foto: 192 }],
  detalleCarga: async () => [{ process_status: 'COGNITIVELY_PROCESSED', ocr_status: 'COMPLETED', embeddings_status: 'COMPLETED', cantidad: 192 }],
  fotosGondola: async () => [{ category_id: 2, categoria: 'DESODORANTES CORPORALES', fotos_entrenamiento: 90, entrenamiento_aprobadas: 60, fotos_visita: 43 }],
});
stub('repositories/enterpriseRepo.js', { findById: async () => ({ Enterprise_dsc: 'Unilever C.A.' }) });

const c = require(path.join(SRC, 'controllers', 'dashboardCatalogoController.js'));
const cliente = { userId: 59, enterpriseId: 35, roleName: 'ADMIN' };
const res = () => ({ code: 200, body: null, headers: {}, chunks: [],
  status(x) { this.code = x; return this; }, json(b) { this.body = b; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, write(s) { this.chunks.push(s); }, end() {} });
const call = async (h, query = {}, user = cliente) => { const r = res(); await h({ user, query }, r); return r; };

beforeEach(() => { calls = []; });

test('productos por categoría: % propios y nombre por defecto', async () => {
  const d = (await call(c.productos)).body.data;
  assert.equal(d[0].pct_propios, 41.3);
  assert.equal(d[1].categoria, 'Categoría 9');
  assert.equal(d[1].pct_propios, null);
});

test('fotos de producto: sin foto y % de cobertura', async () => {
  const d = (await call(c.fotosProducto)).body.data[0];
  assert.deepEqual([d.sin_foto, d.pct_cobertura], [9, 95.5]);
});

test('detalle de carga y fotos de góndola: valores numéricos', async () => {
  assert.equal((await call(c.fotosProductoDetalle)).body.data[0].cantidad, 192);
  const g = (await call(c.fotosGondola)).body.data[0];
  assert.deepEqual([g.fotos_entrenamiento, g.entrenamiento_aprobadas, g.fotos_visita], [90, 60, 43]);
});

test('filtros de la pantalla: empresa y categoría; cadena y fechas se ignoran', async () => {
  await call(c.productos, { category: '2', chain: '5', desde: '2026-01-01' });
  assert.deepEqual([calls[0].enterpriseId, calls[0].category, calls[0].chain, calls[0].desde], [35, 2, null, null]);
});

test('CSV: nombre con pantalla, tarjeta y empresa, sin fechas', async () => {
  const r = await call(c.fotosGondola, { export: 'csv' });
  assert.match(r.headers['content-disposition'], /filename="catalogo_fotos-gondola_unilever\.csv"/);
  assert.ok(r.chunks.join('').includes('DESODORANTES CORPORALES;90;60;43'));
});

test('cliente que pide otra empresa → 403', async () => {
  assert.equal((await call(c.productos, { enterpriseId: '36' })).code, 403);
});
