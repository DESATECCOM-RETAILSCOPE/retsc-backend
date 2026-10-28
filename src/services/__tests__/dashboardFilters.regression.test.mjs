// Dashboard web (Parte B): filtros comunes y resolución de empresa por rol.
//   · ADMIN_DTC elige la empresa; sin elegirla → 400
//   · un cliente siempre ve la suya; si pide otra → 403
//   · cada pantalla acepta solo sus filtros
//   · fechas por defecto: últimos 90 días; hastaExclusive = hasta + 1
// Sin BD. Correr: node src/services/__tests__/dashboardFilters.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveFilters } = require(path.join(process.cwd(), 'src', 'utils', 'dashboardFilters.js'));

const NOW = new Date('2026-10-27T15:00:00Z');
const dtc     = { userId: 1,  enterpriseId: 2,  roleName: 'ADMIN_DTC' };
const cliente = { userId: 59, enterpriseId: 35, roleName: 'ADMIN' };
const req = (user, query = {}) => ({ user, query });
const status = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.statusCode ?? 'sin-status'; } };

test('DTC: usa la empresa elegida en el filtro', () => {
  const f = resolveFilters(req(dtc, { enterpriseId: '35' }), 'cumplimiento', { now: NOW });
  assert.equal(f.enterpriseId, 35);
});

test('DTC: sin elegir empresa → 400', () => {
  assert.equal(status(() => resolveFilters(req(dtc), 'resumen', { now: NOW })), 400);
});

test('DTC: el rol se compara normalizado (minúsculas y espacios)', () => {
  const f = resolveFilters(req({ ...dtc, roleName: ' admin_dtc ' }, { enterpriseId: '35' }), 'resumen', { now: NOW });
  assert.equal(f.enterpriseId, 35);
});

test('Cliente: sin filtro de empresa → la del token', () => {
  const f = resolveFilters(req(cliente), 'cumplimiento', { now: NOW });
  assert.equal(f.enterpriseId, 35);
});

test('Cliente: pedir su propia empresa está permitido', () => {
  const f = resolveFilters(req(cliente, { enterpriseId: '35' }), 'cumplimiento', { now: NOW });
  assert.equal(f.enterpriseId, 35);
});

test('Cliente: pedir otra empresa → 403', () => {
  assert.equal(status(() => resolveFilters(req(cliente, { enterpriseId: '36' }), 'cumplimiento', { now: NOW })), 403);
});

test('Cliente sin empresa en el token → 403', () => {
  assert.equal(status(() => resolveFilters(req({ userId: 9, roleName: 'ADMIN' }), 'resumen', { now: NOW })), 403);
});

test('Fechas por defecto: últimos 90 días contando hoy', () => {
  const f = resolveFilters(req(cliente), 'cumplimiento', { now: NOW });
  assert.equal(f.hasta, '2026-10-27');
  assert.equal(f.desde, '2026-07-30');
  assert.equal(f.hastaExclusive, '2026-10-28');
});

test('Fechas explícitas y hastaExclusive al día siguiente', () => {
  const f = resolveFilters(req(cliente, { desde: '2026-07-01', hasta: '2026-09-30' }), 'cumplimiento', { now: NOW });
  assert.deepEqual([f.desde, f.hasta, f.hastaExclusive], ['2026-07-01', '2026-09-30', '2026-10-01']);
});

test('Fechas inválidas o invertidas → 400', () => {
  assert.equal(status(() => resolveFilters(req(cliente, { desde: '2026-02-30' }), 'resumen', { now: NOW })), 400);
  assert.equal(status(() => resolveFilters(req(cliente, { hasta: '30/09/2026' }), 'resumen', { now: NOW })), 400);
  assert.equal(status(() => resolveFilters(req(cliente, { desde: '2026-10-01', hasta: '2026-09-01' }), 'resumen', { now: NOW })), 400);
});

test('category y chain: enteros positivos; vacío → null; inválido → 400', () => {
  const f = resolveFilters(req(cliente, { category: '2', chain: '' }), 'cumplimiento', { now: NOW });
  assert.equal(f.category, 2);
  assert.equal(f.chain, null);
  assert.equal(status(() => resolveFilters(req(cliente, { category: 'abc' }), 'cumplimiento', { now: NOW })), 400);
  assert.equal(status(() => resolveFilters(req(cliente, { chain: '-3' }), 'cumplimiento', { now: NOW })), 400);
});

test('format se recorta y se limita a 50 caracteres', () => {
  const f = resolveFilters(req(cliente, { format: '  AUTOMERCADO ' }), 'cumplimiento', { now: NOW });
  assert.equal(f.format, 'AUTOMERCADO');
  assert.equal(status(() => resolveFilters(req(cliente, { format: 'x'.repeat(51) }), 'cumplimiento', { now: NOW })), 400);
});

test('Catálogo: ignora cadena, formato y fechas', () => {
  const f = resolveFilters(req(cliente, { category: '2', chain: '5', format: 'X', desde: '2026-01-01' }), 'catalogo', { now: NOW });
  assert.deepEqual([f.enterpriseId, f.category, f.chain, f.format, f.desde], [35, 2, null, null, null]);
});

test('Modelo: sin empresa (global por categoría); DTC no necesita elegir empresa', () => {
  const f = resolveFilters(req(dtc, { category: '2' }), 'modelo', { now: NOW });
  assert.deepEqual([f.enterpriseId, f.category, f.desde], [null, 2, null]);
});

test('Pantalla desconocida → error de programación', () => {
  assert.throws(() => resolveFilters(req(cliente), 'otra', { now: NOW }));
});
