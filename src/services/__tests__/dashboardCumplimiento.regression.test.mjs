// Dashboard web (Parte B), pantalla 2: Cumplimiento.
//   · cada tarjeta responde JSON { success, filtros, data } con los filtros resueltos
//   · ?export=csv descarga el CSV con el nombre acordado con María
//   · un cliente que pide otra empresa recibe 403 y no se consulta la base
//   · parámetros propios (agrupar, limit, por) se validan con 400
//   · composición agrega el porcentaje sobre el total
//   · un error de base devuelve 500 con mensaje genérico
// Sin BD: el repositorio y enterpriseRepo se reemplazan vía require.cache.
// Correr: node src/services/__tests__/dashboardCumplimiento.regression.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');
const abs = (p) => require.resolve(path.join(SRC, p));

let calls;
let failNext;
const stub = (p, e) => { const id = abs(p); require.cache[id] = { id, filename: id, loaded: true, exports: e }; };

stub('repositories/dashboardCumplimientoRepo.js', {
  AGRUPACIONES: ['dia', 'semana', 'mes'],
  DIMENSIONES:  ['marca', 'fabricante', 'subcategoria', 'presentacion'],
  tendencia: async (f, p) => { calls.push(['tendencia', f, p]); if (failNext) throw new Error('db down');
    return [{ periodo: new Date('2026-08-31T00:00:00Z'), visitas: 3, cumplimiento_promedio: 87.4, cumplimiento_minimo: 80, cumplimiento_maximo: 92.5 }]; },
  visitas: async (f) => { calls.push(['visitas', f]); return []; },
  rankingTiendas: async (f, p) => { calls.push(['rankingTiendas', f, p]);
    return [{ tienda: 'Auto Mercado Moravia', cadena: 'Auto Mercado', formato: 'AUTOMERCADO', visitas: 12, cumplimiento_promedio: 94.2, faltantes: 18, prioritarios_faltantes: 2 }]; },
  rankingCadenas: async (f) => { calls.push(['rankingCadenas', f]); return []; },
  excesoPrioritarios: async (f) => { calls.push(['excesoPrioritarios', f]); return []; },
  composicion: async (f, p) => { calls.push(['composicion', f, p]);
    return [{ valor: 'Rexona', cantidad: 9 }, { valor: 'Dove', cantidad: 5 }, { valor: 'Axe', cantidad: 2 }]; },
});
stub('repositories/enterpriseRepo.js', {
  findById: async (id) => (id === 35 ? { Enterprise_id: 35, Enterprise_dsc: 'Unilever C.A.' } : null),
});

const controller = require(path.join(SRC, 'controllers', 'dashboardCumplimientoController.js'));

const cliente = { userId: 59, enterpriseId: 35, roleName: 'ADMIN' };
const dtc     = { userId: 1,  enterpriseId: 2,  roleName: 'ADMIN_DTC' };

function fakeRes() {
  return {
    code: 200, json_: null, headers: {}, chunks: [], ended: false,
    status(c) { this.code = c; return this; },
    json(b) { this.json_ = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(s) { this.chunks.push(s); return true; },
    end() { this.ended = true; },
  };
}
async function call(handler, user, query = {}) {
  const res = fakeRes();
  await handler({ user, query }, res);
  return res;
}

beforeEach(() => { calls = []; failNext = false; });

test('tendencia: JSON con filtros resueltos y agrupar por defecto "semana"', async () => {
  const res = await call(controller.tendencia, cliente, { desde: '2026-07-01', hasta: '2026-09-30', category: '2' });
  assert.equal(res.code, 200);
  assert.equal(res.json_.success, true);
  assert.equal(res.json_.data.length, 1);
  const [, f, p] = calls[0];
  assert.equal(f.enterpriseId, 35);
  assert.equal(f.category, 2);
  assert.equal(f.hastaExclusive, '2026-10-01');
  assert.equal(p.agrupar, 'semana');
  assert.equal(res.json_.filtros.agrupar, 'semana');
});

test('tendencia: agrupar inválido → 400 y no consulta la base', async () => {
  const res = await call(controller.tendencia, cliente, { agrupar: 'anio' });
  assert.equal(res.code, 400);
  assert.equal(calls.length, 0);
});

test('cliente que pide otra empresa → 403 y no consulta la base', async () => {
  const res = await call(controller.visitas, cliente, { enterpriseId: '36' });
  assert.equal(res.code, 403);
  assert.equal(calls.length, 0);
});

test('DTC: consulta la empresa elegida; sin elegirla → 400', async () => {
  await call(controller.rankingCadenas, dtc, { enterpriseId: '35' });
  assert.equal(calls[0][1].enterpriseId, 35);
  const res = await call(controller.rankingCadenas, dtc, {});
  assert.equal(res.code, 400);
});

test('ranking-tiendas: limit válido pasa al repo; fuera de rango → 400', async () => {
  await call(controller.rankingTiendas, cliente, { limit: '5' });
  assert.equal(calls[0][2].limit, 5);
  assert.equal((await call(controller.rankingTiendas, cliente, { limit: '0' })).code, 400);
  assert.equal((await call(controller.rankingTiendas, cliente, { limit: '101' })).code, 400);
});

test('ranking-tiendas con export=csv: nombre de archivo y contenido', async () => {
  const res = await call(controller.rankingTiendas, cliente, { export: 'csv', desde: '2026-07-01', hasta: '2026-09-30' });
  assert.match(res.headers['content-disposition'],
    /filename="cumplimiento_ranking-tiendas_unilever_2026-07-01_2026-09-30\.csv"/);
  const body = res.chunks.join('');
  assert.ok(body.startsWith('\uFEFFTienda;Cadena;Formato;Visitas;Cumplimiento promedio (%);Faltantes;Prioritarios faltantes\r\n'));
  assert.ok(body.includes('Auto Mercado Moravia;Auto Mercado;AUTOMERCADO;12;94,2;18;2\r\n'));
  assert.ok(res.ended);
});

test('tendencia con export=csv: el nombre incluye la agrupación y la fecha sale ISO', async () => {
  const res = await call(controller.tendencia, cliente, { export: 'csv', agrupar: 'mes', desde: '2026-07-01', hasta: '2026-09-30' });
  assert.match(res.headers['content-disposition'], /cumplimiento_tendencia-mes_unilever_2026-07-01_2026-09-30\.csv/);
  assert.ok(res.chunks.join('').includes('2026-08-31;3;87,4;80;92,5'));
});

test('composición: porcentaje sobre el total y "por" por defecto "marca"', async () => {
  const res = await call(controller.composicion, cliente, {});
  assert.equal(calls[0][2].por, 'marca');
  assert.deepEqual(res.json_.data.map((r) => r.porcentaje), [56.3, 31.3, 12.5]);
});

test('composición: "por" inválido → 400', async () => {
  assert.equal((await call(controller.composicion, cliente, { por: 'color' })).code, 400);
});

test('composición vacía: porcentaje null sin dividir por cero', () => {
  const { withShare } = controller._internals;
  assert.deepEqual(withShare([]), []);
  assert.deepEqual(withShare([{ valor: 'X', cantidad: 0 }]).map((r) => r.porcentaje), [null]);
});

test('error de base → 500 con mensaje genérico (sin detalles internos)', async () => {
  failNext = true;
  const origError = console.error; console.error = () => {};
  try {
    const res = await call(controller.tendencia, cliente, {});
    assert.equal(res.code, 500);
    assert.equal(res.json_.message, 'Error al obtener los datos del dashboard.');
  } finally { console.error = origError; }
});
