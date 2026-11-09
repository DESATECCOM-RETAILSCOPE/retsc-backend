// Dashboard web (Parte B), pantalla 4: Modelo IA & OCR.
//   · iteración: métricas de 0 a 1 pasadas a %; estado según los mínimos del pipeline
//   · OCR: sin empresa ni fechas (todas las empresas, todo el período); porcentajes
//   · la pantalla solo usa categoría: DTC no necesita elegir empresa
//   · CSV sin empresa ni fechas en el nombre
// Sin BD: repositorio simulado vía require.cache.
// Correr: node src/services/__tests__/dashboardModelo.regression.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');
const stub = (p, e) => { const id = require.resolve(path.join(SRC, p)); require.cache[id] = { id, filename: id, loaded: true, exports: e }; };

let calls, modelos;
stub('repositories/dashboardModeloRepo.js', {
  ultimaIteracion: async (cat) => { calls.push(['iter', cat]); return modelos; },
  lecturaOcr: async (f) => { calls.push(['ocr', f]); return { total_detecciones: 429, con_texto_leido: 298, texto_leido_con_match: 230 }; },
});
stub('repositories/enterpriseRepo.js', { findById: async () => null });

const c = require(path.join(SRC, 'controllers', 'dashboardModeloController.js'));
const { estadoModelo } = c._internals;
const dtc = { userId: 1, enterpriseId: 2, roleName: 'ADMIN_DTC' };
const res = () => ({ code: 200, body: null, headers: {}, chunks: [],
  status(x) { this.code = x; return this; }, json(b) { this.body = b; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, write(s) { this.chunks.push(s); }, end() {} });
const call = async (h, query = {}) => { const r = res(); await h({ user: dtc, query }, r); return r; };

beforeEach(() => {
  calls = [];
  modelos = [{ category_id: 2, categoria: 'DESODORANTES CORPORALES', model_version: 11, status: 'PUBLISHED', is_active: true,
    precision_score: 0.932, recall_score: 0.823, mean_ap: 0.9, trained_at: '2026-09-12T00:00:00.000Z', last_publish_name: 'Iteration11' }];
});

test('iteración: métricas en % y estado Activo; DTC sin elegir empresa', async () => {
  const r = await call(c.iteracion, { category: '2' });
  assert.equal(r.code, 200);
  const d = r.body.data[0];
  assert.deepEqual([d.precision_pct, d.recall_pct, d.map_pct, d.estado], [93.2, 82.3, 90, 'Activo']);
  assert.deepEqual(calls[0], ['iter', 2]);
});

test('estado del modelo según los mínimos (precisión 0,80 y recall 0,75)', () => {
  assert.equal(estadoModelo({ precision_score: 0.79, recall_score: 0.9, is_active: true }), 'Revisar');
  assert.equal(estadoModelo({ precision_score: 0.9, recall_score: 0.74, is_active: true }), 'Revisar');
  assert.equal(estadoModelo({ precision_score: 0.9, recall_score: 0.8, is_active: false }), 'Inactivo');
  assert.equal(estadoModelo({ precision_score: null, recall_score: 0.8 }), 'Sin métricas');
});

test('OCR: sin empresa ni fechas, con porcentajes', async () => {
  const d = (await call(c.ocr, { category: '2' })).body.data;
  const f = calls.find((x) => x[0] === 'ocr')[1];
  assert.deepEqual([f.enterpriseId, f.category, f.desde, f.hastaExclusive], [null, 2, null, null]);
  assert.deepEqual([d.texto_leido_sin_match, d.pct_tasa_lectura, d.pct_match_sobre_texto_leido, d.pct_sin_match], [68, 69.5, 77.2, 22.8]);
});

test('CSV: nombre sin empresa ni fechas', async () => {
  const r = await call(c.iteracion, { export: 'csv' });
  assert.match(r.headers['content-disposition'], /filename="modelo_iteracion\.csv"/);
});
