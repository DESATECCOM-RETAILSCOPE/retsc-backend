// Dashboard web (Parte B): exportación CSV con el formato acordado con María.
//   · nombre pantalla_tarjeta_empresa_desde_hasta.csv
//   · BOM + separador ";" + encabezados legibles + CRLF
//   · decimales con coma, campos con ; o comillas entre comillas
//   · escribe en tandas y acepta iterables async
// Sin BD. Correr: node src/services/__tests__/csvExport.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const csv = require(path.join(process.cwd(), 'src', 'utils', 'csvExport.js'));

function fakeRes() {
  return {
    headers: {}, chunks: [], code: null, ended: false,
    status(c) { this.code = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(s) { this.chunks.push(s); return true; },
    end() { this.ended = true; },
    body() { return this.chunks.join(''); },
  };
}

test('Nombre de archivo: ejemplo de María', () => {
  const name = csv.buildCsvFilename({
    pantalla: 'cumplimiento', tarjeta: 'ranking-tiendas', empresa: 'Unilever C.A.',
    desde: '2026-07-01', hasta: '2026-09-30',
  });
  assert.equal(name, 'cumplimiento_ranking-tiendas_unilever_2026-07-01_2026-09-30.csv');
});

test('Nombre de archivo: tildes y espacios; omite partes vacías', () => {
  assert.equal(csv.buildCsvFilename({ pantalla: 'Catálogo', tarjeta: 'fotos producto', empresa: 'Café Britt S.A.' }),
    'catalogo_fotos-producto_cafe-britt.csv');
  assert.equal(csv.buildCsvFilename({ pantalla: 'modelo', tarjeta: 'iteracion' }), 'modelo_iteracion.csv');
});

test('Formato de valores: coma decimal, fechas ISO, null vacío, booleanos', () => {
  assert.equal(csv.formatValue(87.4), '87,4');
  assert.equal(csv.formatValue(3482), '3482');
  assert.equal(csv.formatValue(null), '');
  assert.equal(csv.formatValue(NaN), '');
  assert.equal(csv.formatValue(new Date('2026-09-28T00:00:00Z')), '2026-09-28');
  assert.equal(csv.formatValue(new Date('2026-09-28T01:31:05Z')), '2026-09-28 01:31:05');
  assert.equal(csv.formatValue(true), 'Sí');
});

test('Escape: campos con ; comillas o saltos de línea van entre comillas', () => {
  const cols = [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }];
  assert.equal(csv.toCsvLine({ a: 'Más x Menos; San Pedro', b: 'dijo "hola"' }, cols),
    '"Más x Menos; San Pedro";"dijo ""hola"""');
});

test('sendCsv: headers, BOM, encabezados legibles y filas', async () => {
  const res = fakeRes();
  await csv.sendCsv(res, {
    filename: 'cumplimiento_ranking-tiendas_unilever_2026-07-01_2026-09-30.csv',
    columns: [{ key: 'tienda', header: 'Tienda' }, { key: 'pct', header: 'Cumplimiento promedio (%)' }],
    rows: [{ tienda: 'Auto Mercado Moravia', pct: 94.2 }, { tienda: 'Pali Alajuela', pct: 79.6 }],
  });
  assert.equal(res.code, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(res.headers['content-disposition'], /attachment; filename="cumplimiento_ranking-tiendas_unilever_2026-07-01_2026-09-30\.csv"/);
  assert.ok(res.ended);
  assert.equal(res.body(),
    '\uFEFFTienda;Cumplimiento promedio (%)\r\nAuto Mercado Moravia;94,2\r\nPali Alajuela;79,6\r\n');
});

test('sendCsv: sin filas deja solo BOM y encabezados', async () => {
  const res = fakeRes();
  await csv.sendCsv(res, { filename: 'x.csv', columns: [{ key: 'a', header: 'A' }], rows: [] });
  assert.equal(res.body(), '\uFEFFA\r\n');
});

test('sendCsv: escribe en tandas y acepta un iterable async', async () => {
  async function* gen() { for (let i = 0; i < 1200; i++) yield { n: i }; }
  const res = fakeRes();
  await csv.sendCsv(res, { filename: 'x.csv', columns: [{ key: 'n', header: 'N' }], rows: gen() });
  assert.equal(res.chunks.length, 1 + 3); // encabezado + 500 + 500 + 200
  assert.equal(res.body().split('\r\n').length, 1 + 1200 + 1);
});

test('format propio por columna', () => {
  const cols = [{ key: 'pct', header: '%', format: (v) => (v == null ? '' : `${v}%`) }];
  assert.equal(csv.toCsvLine({ pct: 50 }, cols), '50%');
});

test('wantsCsv detecta ?export=csv', () => {
  assert.equal(csv.wantsCsv({ query: { export: 'CSV' } }), true);
  assert.equal(csv.wantsCsv({ query: {} }), false);
});
