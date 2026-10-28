// Dashboard web (Parte B): GET /api/dashboard/opciones.
//   · cliente: usa la empresa del token; si pide otra → 403 sin consultar la base
//   · ADMIN_DTC: usa la empresa elegida; sin elegirla → 400
//   · error de base → 500 con mensaje genérico
// Sin BD: el repositorio se reemplaza vía require.cache.
// Correr: node src/services/__tests__/dashboardOpciones.regression.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');
let calls, failNext;
const repoId = require.resolve(path.join(SRC, 'repositories', 'dashboardOpcionesRepo.js'));
require.cache[repoId] = { id: repoId, filename: repoId, loaded: true, exports: {
  opciones: async (id) => { calls.push(id); if (failNext) throw new Error('db down');
    return { categorias: [{ id: 2, nombre: 'DESODORANTES CORPORALES' }], cadenas: [{ id: 1, nombre: 'AUTOMERCADO' }], formatos: ['AUTOMERCADO'] }; },
} };
const { opciones } = require(path.join(SRC, 'controllers', 'dashboardOpcionesController.js'));

const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (user, query = {}) => { const r = res(); await opciones({ user, query }, r); return r; };
const cliente = { userId: 59, enterpriseId: 35, roleName: 'ADMIN' };
const dtc = { userId: 1, enterpriseId: 2, roleName: 'ADMIN_DTC' };

beforeEach(() => { calls = []; failNext = false; });

test('cliente: opciones de su empresa', async () => {
  const r = await call(cliente);
  assert.equal(r.code, 200);
  assert.deepEqual(calls, [35]);
  assert.equal(r.body.data.categorias[0].nombre, 'DESODORANTES CORPORALES');
});

test('cliente que pide otra empresa → 403 sin consultar', async () => {
  const r = await call(cliente, { enterpriseId: '36' });
  assert.equal(r.code, 403);
  assert.equal(calls.length, 0);
});

test('DTC: empresa elegida; sin elegir → 400', async () => {
  await call(dtc, { enterpriseId: '35' });
  assert.deepEqual(calls, [35]);
  assert.equal((await call(dtc)).code, 400);
});

test('error de base → 500 genérico', async () => {
  failNext = true;
  const e = console.error; console.error = () => {};
  try {
    const r = await call(cliente);
    assert.equal(r.code, 500);
    assert.equal(r.body.message, 'Error al obtener las opciones de los filtros.');
  } finally { console.error = e; }
});
