// Pruebas de admReceivablesService (antigüedad de saldos, CSV y facturas con saldo, paso 6).
//
// Qué se prueba: filtros de aging, el CSV con el formato del dashboard (BOM, ";", coma decimal,
//   2 decimales, escape, protección contra fórmulas), los filtros de receivables y que las banderas y el orden
//   que calcula SQL lleguen intactos a la respuesta.
// Cómo: SIN base de datos. El repositorio se reemplaza en require.cache por una simulación.
//   Las banderas dueSoon / followUpDue y el orden se calculan en SQL; como aquí no hay base, se
//   revisa el TEXTO SQL que arma buildReceivablesQuery (los límites de fecha exactos) y se
//   comprueba con filas "como las devolvería la base" que el servicio no las altera.
//   El comportamiento real contra la base lo cubre pruebas_adm_paso6.sh en QA.
// Correr: node --test src/services/__tests__/admReceivablesService.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');

// El repositorio REAL solo se carga para probar sus funciones puras build*Query (no se conecta:
// getPool solo se llama al ejecutar una consulta, y aquí no se ejecuta ninguna).
const realRepo = require(path.join(SRC, 'repositories', 'admReceivablesRepo.js'));

// Reemplaza un módulo por un objeto propio antes de que el servicio lo cargue.
const stub = (p, exportsObj) => {
  const id = require.resolve(path.join(SRC, p));
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
};

// Simulación del repositorio: guarda los filtros recibidos y devuelve las filas preparadas.
let calls;
let agingRows;
let receivableRows;
beforeEach(() => {
  calls = {};
  agingRows = [];
  receivableRows = [];
});
stub('repositories/admReceivablesRepo.js', {
  listAging: async (filters) => { calls.aging = filters; return agingRows; },
  listReceivables: async (filters) => { calls.receivables = filters; return receivableRows; },
});

const service = require(path.join(SRC, 'services', 'admReceivablesService.js'));

// Error esperado: devuelve { status, field }.
const failure = async (promise) => {
  try { await promise; } catch (e) { return { status: e.statusCode, field: e.payload?.field }; }
  assert.fail('se esperaba un error y la operación terminó bien');
};

// Fila de la vista de antigüedad como la devolvería la base.
const agingRow = (over = {}) => ({
  Enterprise_id: 35, Enterprise_dsc: 'Empresa Prueba', Currency: 'USD',
  Vigente: 100, Vencido_1_30: 0, Vencido_31_60: 1130.5, Vencido_61_90: 0, Vencido_mas_90: 0,
  Saldo_total: 1230.5, Facturas_con_saldo: 2, ...over,
});

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------
test('Aging sin filtros: enterpriseId y currency en null (DTC ve todas las empresas)', async () => {
  agingRows = [agingRow()];
  const r = await service.getAging({});
  assert.deepEqual(calls.aging, { enterpriseId: null, currency: null });
  assert.equal(r.format, 'json');
  assert.deepEqual(r.aging[0], {
    enterpriseId: 35, enterpriseName: 'Empresa Prueba', currency: 'USD',
    vigente: 100, vencido1a30: 0, vencido31a60: 1130.5, vencido61a90: 0, vencidoMas90: 0,
    saldoTotal: 1230.5, facturasConSaldo: 2,
  });
});

test('Aging con filtros: empresa y moneda normalizadas', async () => {
  await service.getAging({ enterpriseId: '36', currency: 'crc' });
  assert.deepEqual(calls.aging, { enterpriseId: 36, currency: 'CRC' });
});

test('Aging con filtros inválidos -> 422 con su campo', async () => {
  assert.deepEqual(await failure(service.getAging({ enterpriseId: 'abc' })), { status: 422, field: 'enterpriseId' });
  assert.deepEqual(await failure(service.getAging({ currency: 'EUR' })), { status: 422, field: 'currency' });
  assert.deepEqual(await failure(service.getAging({ export: 'xlsx' })), { status: 422, field: 'export' });
});

test('SQL de aging: LEFT JOIN a empresas solo por el nombre, filtros parametrizados y orden', () => {
  const { text, params } = realRepo.buildAgingQuery({ enterpriseId: 35, currency: 'USD' });
  assert.match(text, /LEFT JOIN RETSC_OP_ENTERPRISE e/);
  assert.match(text, /e\.Enterprise_dsc/);
  assert.doesNotMatch(text, /Fiscal_id|Invoice_mail|Address/);
  assert.match(text, /ORDER BY e\.Enterprise_dsc ASC, a\.Enterprise_id ASC, a\.Currency ASC/);
  assert.deepEqual(params.map((p) => [p.name, p.value]), [['enterpriseId', 35], ['currency', 'USD']]);
  assert.doesNotMatch(realRepo.buildAgingQuery({}).text, /WHERE/);
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
// Respuesta HTTP simulada: junta lo que csvExport.sendCsv escribe (cabeceras y contenido).
function fakeRes() {
  return {
    statusCode: null, headers: {}, chunks: [], ended: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    write(chunk) { this.chunks.push(chunk); },
    end() { this.ended = true; },
    json(body) { this.body = body; return this; },
    get text() { return this.chunks.join(''); },
  };
}

// Descarga el CSV pasando por el controlador real, que usa el util compartido csvExport.sendCsv.
async function downloadCsv(query) {
  const controller = require(path.join(SRC, 'controllers', 'admReceivablesController.js'));
  const res = fakeRes();
  await controller.getAging({ query }, res);
  return res;
}

test('CSV: formato del dashboard — BOM, ";", coma decimal con 2 decimales, CRLF y cabeceras', async () => {
  agingRows = [agingRow()];
  const res = await downloadCsv({ export: 'csv' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.ended, true);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.ok(res.text.startsWith('\uFEFF'), 'debe empezar con el BOM UTF-8');
  const lines = res.text.slice(1).split('\r\n');
  assert.equal(lines[0], 'ID empresa;Empresa;Moneda;Vigente;Vencido 1 a 30 días;Vencido 31 a 60 días;Vencido 61 a 90 días;Vencido más de 90 días;Saldo total;Facturas con saldo');
  assert.equal(lines[1], '35;Empresa Prueba;USD;100,00;0,00;1130,50;0,00;0,00;1230,50;2');
  assert.equal(lines[2], '', 'el archivo termina con salto de línea');
});

test('CSV: nombre con la fecha de Costa Rica y Content-Disposition de descarga', async () => {
  // 03:00 UTC del 23-nov = 21:00 del 22-nov en Costa Rica: el archivo debe llevar el 22.
  const r = await service.getAging({ export: 'csv' }, new Date('2026-11-23T03:00:00Z'));
  assert.equal(r.format, 'csv');
  assert.equal(r.filename, 'cuentas-por-cobrar-2026-11-22.csv');
  // El controlador manda ese nombre en Content-Disposition (vía el util compartido).
  const res = await downloadCsv({ export: 'csv' });
  assert.match(res.headers['content-disposition'], /^attachment; filename="cuentas-por-cobrar-\d{4}-\d{2}-\d{2}\.csv"/);
});

test('CSV: ";" y comillas se escapan; las comas ya no necesitan comillas; fórmulas con comilla simple', async () => {
  agingRows = [
    agingRow({ Enterprise_id: 1, Enterprise_dsc: 'Lácteos "La Vaca"; S.A.' }),
    agingRow({ Enterprise_id: 2, Enterprise_dsc: 'Comercial Uno, S.A.' }),
    agingRow({ Enterprise_id: 3, Enterprise_dsc: '=HYPERLINK("http://x";"clic")' }),
  ];
  const lines = (await downloadCsv({ export: 'csv' })).text.slice(1).split('\r\n');
  assert.ok(lines[1].startsWith('1;"Lácteos ""La Vaca""; S.A.";USD;'));
  assert.ok(lines[2].startsWith('2;Comercial Uno, S.A.;USD;'));
  assert.ok(lines[3].startsWith(`3;"'=HYPERLINK(""http://x"";""clic"")";USD;`));
});

test('CSV: protección de fórmulas y montos en el servicio (no en el util compartido)', () => {
  // Las cuatro marcas de fórmula llevan comilla simple; un texto normal queda igual.
  assert.equal(service._safeText('=1+1'), "'=1+1");
  assert.equal(service._safeText('+1'), "'+1");
  assert.equal(service._safeText('-1'), "'-1");
  assert.equal(service._safeText('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(service._safeText('Empresa'), 'Empresa');
  assert.equal(service._safeText(null), '');
  // Montos: 2 decimales y coma decimal. Un monto negativo es número, no lleva comilla simple.
  assert.equal(service._moneyCell(1130.5), '1130,50');
  assert.equal(service._moneyCell(0), '0,00');
  assert.equal(service._moneyCell(-5.5), '-5,50');
  assert.equal(service._moneyCell(null), '');
});

// ---------------------------------------------------------------------------
// Receivables
// ---------------------------------------------------------------------------

// "Hoy" fijo para las filas de ejemplo: 2026-11-22. Cada fila es lo que devolvería la base
// para ese día con las reglas del SQL (los límites exactos se prueban en el texto SQL abajo).
const recRow = (id, over = {}) => ({
  Invoice_id: id, Enterprise_id: 35, Enterprise_dsc: 'Empresa Prueba', Contract_id: 10,
  Invoice_number: `PRUEBA-${id}`, Due_date: new Date('2026-11-22T00:00:00Z'), Currency: 'USD',
  Total_amount: 1130, Balance: 630, Payment_status: 'PARCIAL', Days_overdue: 0, Aging_bucket: 'VIGENTE',
  Next_contact_date: null, Last_note: null, Overdue: 0, Due_soon: 0, Follow_up_due: 0, ...over,
});

test('Receivables: filtros normalizados y filtro inválido -> 422', async () => {
  await service.listReceivables({ enterpriseId: '35', currency: 'usd', filter: 'followUp' });
  assert.deepEqual(calls.receivables, { enterpriseId: 35, currency: 'USD', filter: 'followUp' });
  await service.listReceivables({});
  assert.deepEqual(calls.receivables, { enterpriseId: null, currency: null, filter: null });
  assert.deepEqual(await failure(service.listReceivables({ filter: 'vencidas' })), { status: 422, field: 'filter' });
});

test('SQL de receivables: límites de dueSoon (hoy..hoy+7 incluidos) y followUpDue (hoy o antes)', () => {
  const { text, params } = realRepo.buildReceivablesQuery({});
  // "Hoy" en Costa Rica, igual que en facturas.
  assert.match(text, /DECLARE @hoy date = CAST\(SWITCHOFFSET\(SYSDATETIMEOFFSET\(\), '-06:00'\) AS date\)/);
  // Vence hoy -> sí (>= @hoy). Vence hoy+7 -> sí (<= hoy+7). Vence hoy+8 -> no. Vencida ayer -> no.
  assert.match(text, /b\.Due_date >= @hoy AND b\.Due_date <= DATEADD\(DAY, @dueSoonDays, @hoy\)/);
  assert.deepEqual(params.find((p) => p.name === 'dueSoonDays').value, 7);
  // Nota de hoy -> sí; de ayer -> sí; de mañana -> no; sin fecha -> no.
  assert.match(text, /n\.Next_contact_date IS NOT NULL AND n\.Next_contact_date <= @hoy/);
  assert.match(text, /CASE WHEN b\.Days_overdue > 0 THEN 1 ELSE 0 END AS Overdue/);
  // Solo facturas con saldo, última nota por Note_id y orden pedido.
  assert.match(text, /b\.Balance > 0/);
  assert.match(text, /OUTER APPLY \(\s*SELECT TOP 1 cn\.Note, cn\.Next_contact_date[\s\S]*ORDER BY cn\.Note_id DESC/);
  assert.match(text, /ORDER BY x\.Follow_up_due DESC, x\.Due_date ASC/);
  assert.doesNotMatch(text, /x\.Overdue = 1|x\.Due_soon = 1|x\.Follow_up_due = 1/);
});

test('SQL de receivables: cada ?filter= agrega su condición sobre las banderas', () => {
  assert.match(realRepo.buildReceivablesQuery({ filter: 'overdue' }).text, /WHERE x\.Overdue = 1/);
  assert.match(realRepo.buildReceivablesQuery({ filter: 'dueSoon' }).text, /WHERE x\.Due_soon = 1/);
  assert.match(realRepo.buildReceivablesQuery({ filter: 'followUp' }).text, /WHERE x\.Follow_up_due = 1/);
  const withScope = realRepo.buildReceivablesQuery({ enterpriseId: 35, currency: 'CRC' });
  assert.match(withScope.text, /b\.Enterprise_id = @enterpriseId AND b\.Currency = @currency/);
});

test('Receivables: banderas de los casos límite llegan como 1/0 y se respeta el orden de la base', async () => {
  // Hoy = 2026-11-22. Orden como lo devuelve SQL: primero followUpDue = 1, luego por vencimiento.
  receivableRows = [
    recRow(1, { Next_contact_date: new Date('2026-11-21T00:00:00Z'), Last_note: 'PRUEBA ayer', Follow_up_due: 1, Due_date: new Date('2026-09-13T00:00:00Z'), Days_overdue: 70, Overdue: 1, Aging_bucket: 'VENCIDO_61_90' }),
    recRow(2, { Next_contact_date: new Date('2026-11-22T00:00:00Z'), Last_note: 'PRUEBA hoy', Follow_up_due: 1, Due_date: new Date('2026-12-12T00:00:00Z') }),
    recRow(3, { Due_soon: 1 }),                                                   // vence hoy
    recRow(4, { Due_date: new Date('2026-11-29T00:00:00Z'), Due_soon: 1 }),       // vence hoy+7
    recRow(5, { Due_date: new Date('2026-11-30T00:00:00Z'), Next_contact_date: new Date('2026-11-23T00:00:00Z'), Last_note: 'PRUEBA mañana' }), // hoy+8, nota de mañana
  ];
  const list = await service.listReceivables({});
  assert.deepEqual(list.map((r) => r.invoiceId), [1, 2, 3, 4, 5]);
  assert.deepEqual(list.map((r) => [r.overdue, r.dueSoon, r.followUpDue]), [
    [1, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 0], [0, 0, 0],
  ]);
  assert.deepEqual(list[0], {
    invoiceId: 1, enterpriseId: 35, enterpriseName: 'Empresa Prueba', contractId: 10, invoiceNumber: 'PRUEBA-1',
    dueDate: '2026-09-13', currency: 'USD', totalAmount: 1130, balance: 630, paymentStatus: 'PARCIAL',
    daysOverdue: 70, agingBucket: 'VENCIDO_61_90', nextContactDate: '2026-11-21', lastNote: 'PRUEBA ayer',
    overdue: 1, dueSoon: 0, followUpDue: 1,
  });
  assert.equal(list[4].nextContactDate, '2026-11-23');
});
