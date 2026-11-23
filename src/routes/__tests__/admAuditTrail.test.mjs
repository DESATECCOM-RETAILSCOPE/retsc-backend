// Pruebas de "BITÁCORA COMPLETA" (sección 9 del contexto ADM): cada escritura del módulo deja su
// fila en RETSC_ADM_AUDIT_LOG DENTRO de la misma transacción, y si la bitácora falla la operación
// no se guarda.
//
// Qué cubre, para CADA función de escritura de admContractRepo, admBillingProfileRepo,
// admInvoiceRepo y admPaymentRepo:
//   (1) camino feliz: begin -> ... -> INSERT en RETSC_ADM_AUDIT_LOG (por la transacción, no por el
//       pool) -> commit; sin rollback;
//   (2) si el INSERT de bitácora lanza un error: rollback, NUNCA commit, y el error llega a quien llamó;
//   (3) si la operación principal lanza un error (2601 de índice único): rollback, sin commit y sin
//       fila de bitácora.
// Además verifica que no haya funciones de escritura sin cubrir (un INSERT/UPDATE/DELETE nuevo en
// estos repositorios rompe la prueba) y documenta la excepción de admNoteRepo (no audita).
//
// Cómo, sin base: src/config/db se reemplaza en require.cache por un pool y una transacción
// SIMULADOS que anotan cada evento (begin, consultas, commit, rollback) y responden a cada consulta
// con filas plausibles según el texto SQL (OUTPUT INSERTED, SELECT ... UPDLOCK, SUM, vista de saldos).
// Todas las funciones se prueban con esta simulación: no hizo falta recurrir a inspección de código.
//
// Correr: node --test src/routes/__tests__/admAuditTrail.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');

// ---------------------------------------------------------------------------
// Base de datos simulada
// ---------------------------------------------------------------------------

// Estado de la simulación para la prueba en curso.
//   events : lista ordenada de lo que pasó ({ type: 'begin'|'commit'|'rollback'|'query', via, text })
//   failOn : expresión regular; la PRIMERA consulta cuyo texto coincida lanza `failError`
//   rows   : filas que devuelven las lecturas bloqueadas (se ajustan por caso)
let sim;
function resetSim({ failOn = null, failError = null, rows = {} } = {}) {
  sim = { events: [], failOn, failError, failed: false, rows };
}

// Error como el que lanza mssql al violar un índice único (2601).
function uniqueViolation() {
  const e = new Error("Cannot insert duplicate key row in object 'dbo.X' with unique index 'UX_PRUEBA'.");
  e.number = 2601;
  return e;
}

// Fila genérica "como la devolvería OUTPUT INSERTED.*": trae los ids y columnas que leen los repos.
const GENERIC_ROW = {
  Contract_id: 10, Enterprise_id: 35, Invoice_id: 50, Payment_id: 70, PO_id: 100,
  Status: 'ACTIVO', Currency: 'USD', Void_reason: null,
};

// Respuesta simulada según el texto SQL de la consulta.
function respond(text) {
  // Bitácora: no devuelve filas.
  if (/INSERT INTO RETSC_ADM_AUDIT_LOG/.test(text)) return { recordset: [], rowsAffected: [1] };
  // Sumas (facturado contra la OC, pagos aplicados).
  if (/SUM\(/.test(text)) return { recordset: [{ total: 0 }] };
  // Lecturas bloqueadas (fila actual antes de cambiarla).
  if (/FROM RETSC_ADM_CONTRACT WITH \(UPDLOCK/.test(text)) return { recordset: [sim.rows.contract ?? { ...GENERIC_ROW }] };
  if (/FROM RETSC_ADM_BILLING_PROFILE WITH \(UPDLOCK/.test(text)) return { recordset: sim.rows.billing ? [sim.rows.billing] : [] };
  if (/FROM RETSC_ADM_PURCHASE_ORDER WITH \(UPDLOCK/.test(text)) return { recordset: [sim.rows.po ?? { ...GENERIC_ROW, Status: 'VALIDADA', Amount: 1130 }] };
  if (/FROM RETSC_ADM_INVOICE WITH \(UPDLOCK/.test(text)) return { recordset: [sim.rows.invoice ?? { ...GENERIC_ROW, Status: 'REGISTRADA', Total_amount: 1130 }] };
  if (/FROM RETSC_ADM_PAYMENT WITH \(UPDLOCK/.test(text)) return { recordset: [sim.rows.payment ?? { ...GENERIC_ROW, Status: 'APLICADO' }] };
  // Vista de saldos (después de un pago o una anulación).
  if (/RETSC_ADM_V_INVOICE_BALANCE/.test(text)) return { recordset: [{ Invoice_id: 50, Total_amount: 1130, Paid_total: 0, Balance: 1130, Payment_status: 'PENDIENTE' }] };
  // Relectura de la factura recién insertada (para traer Due_date).
  if (/SELECT \* FROM RETSC_ADM_INVOICE WHERE Invoice_id/.test(text)) return { recordset: [{ ...GENERIC_ROW, Due_date: new Date('2026-12-01T00:00:00Z') }] };
  // Escrituras con OUTPUT (INSERT/UPDATE ... OUTPUT INSERTED.*).
  if (/OUTPUT INSERTED/.test(text)) return { recordset: [{ ...GENERIC_ROW }], rowsAffected: [1] };
  // UPDATE sin OUTPUT (cierre de OC).
  if (/^\s*UPDATE /m.test(text)) return { recordset: [], rowsAffected: [1] };
  throw new Error(`La simulación no reconoce esta consulta:\n${text}`);
}

// Crea un "request" que anota la consulta (con el canal: pool o transacción) y responde.
function makeRequest(via) {
  return {
    input() { return this; },
    async query(text) {
      sim.events.push({ type: 'query', via, text });
      if (sim.failOn && !sim.failed && sim.failOn.test(text)) {
        sim.failed = true;
        throw sim.failError;
      }
      return respond(text);
    },
  };
}

const fakePool = {
  request: () => makeRequest('pool'),
  transaction: () => ({
    async begin() { sim.events.push({ type: 'begin' }); },
    async commit() { sim.events.push({ type: 'commit' }); },
    async rollback() { sim.events.push({ type: 'rollback' }); },
    request: () => makeRequest('transaction'),
  }),
};

const dbId = require.resolve(path.join(SRC, 'config', 'db.js'));
require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  // `sql` real de mssql: solo tipos, no conecta a nada.
  exports: { getPool: async () => fakePool, sql: require('mssql') },
};

const contractRepo = require(path.join(SRC, 'repositories', 'admContractRepo.js'));
const billingRepo = require(path.join(SRC, 'repositories', 'admBillingProfileRepo.js'));
const invoiceRepo = require(path.join(SRC, 'repositories', 'admInvoiceRepo.js'));
const paymentRepo = require(path.join(SRC, 'repositories', 'admPaymentRepo.js'));
const noteRepo = require(path.join(SRC, 'repositories', 'admNoteRepo.js'));

// ---------------------------------------------------------------------------
// Casos: cada función de escritura, con la consulta que es su "operación principal"
// ---------------------------------------------------------------------------
const CTX = { userId: 1, ipAddress: '10.0.0.1' };
const INVOICE_REC = {
  enterpriseId: 35, contractId: 10, poId: null, invoiceNumber: 'PRUEBA-1', invoiceKey: null,
  issueDate: '2026-11-01', receivedDate: null, creditDays: 30, subtotal: 1000, taxAmount: 130,
  totalAmount: 1130, currency: 'USD', periodFrom: null, periodTo: null,
};

const CASES = [
  {
    name: 'admContractRepo.createWithAudit',
    fn: 'contract.createWithAudit',
    main: /INSERT INTO RETSC_ADM_CONTRACT/,
    expectedAudits: 1,
    run: () => contractRepo.createWithAudit({
      enterpriseId: 35, planCode: 'PRUEBA', status: 'BORRADOR', startDate: '2026-11-01', endDate: null,
      billingFrequency: 'MENSUAL', amountPerPeriod: 100, currency: 'USD', paymentMethod: 'OC_FACTURA',
      creditDays: 30, requiresPo: false, issuerName: null,
    }, CTX),
  },
  {
    name: 'admContractRepo.updateWithAudit',
    fn: 'contract.updateWithAudit',
    main: /UPDATE RETSC_ADM_CONTRACT/,
    expectedAudits: 1,
    run: () => contractRepo.updateWithAudit(10, { Plan_code: 'PRUEBA-2' }, CTX),
  },
  {
    name: 'admBillingProfileRepo.upsertWithAudit (alta)',
    fn: 'billing.upsertWithAudit',
    main: /INSERT INTO RETSC_ADM_BILLING_PROFILE/,
    expectedAudits: 1,
    rows: { billing: null },
    run: () => billingRepo.upsertWithAudit({
      enterpriseId: 35, legalName: 'PRUEBA S.A.', taxId: '3-101-000000', billingEmail: 'prueba@ejemplo.com',
      billingAddress: null, country: 'CR',
    }, CTX),
  },
  {
    name: 'admBillingProfileRepo.upsertWithAudit (edición)',
    fn: 'billing.upsertWithAudit',
    main: /UPDATE RETSC_ADM_BILLING_PROFILE/,
    expectedAudits: 1,
    rows: { billing: { Enterprise_id: 35, Legal_name: 'VIEJA S.A.' } },
    run: () => billingRepo.upsertWithAudit({
      enterpriseId: 35, legalName: 'PRUEBA S.A.', taxId: '3-101-000000', billingEmail: 'prueba@ejemplo.com',
      billingAddress: null, country: 'CR',
    }, CTX),
  },
  {
    name: 'admInvoiceRepo.createWithAudit (sin OC)',
    fn: 'invoice.createWithAudit',
    main: /INSERT INTO RETSC_ADM_INVOICE/,
    expectedAudits: 1,
    run: () => invoiceRepo.createWithAudit(INVOICE_REC, CTX, () => ({ closePo: false })),
  },
  {
    name: 'admInvoiceRepo.createWithAudit (con OC que se CIERRA: dos filas de bitácora)',
    fn: 'invoice.createWithAudit',
    main: /INSERT INTO RETSC_ADM_INVOICE/,
    expectedAudits: 2,
    run: () => invoiceRepo.createWithAudit({ ...INVOICE_REC, poId: 100 }, CTX, () => ({ closePo: true })),
  },
  {
    name: 'admInvoiceRepo.changeStatusWithAudit',
    fn: 'invoice.changeStatusWithAudit',
    main: /UPDATE RETSC_ADM_INVOICE/,
    expectedAudits: 1,
    run: () => invoiceRepo.changeStatusWithAudit(50, { status: 'ANULADA', voidReason: 'PRUEBA' }, CTX, () => {}),
  },
  {
    name: 'admPaymentRepo.createWithAudit',
    fn: 'payment.createWithAudit',
    main: /INSERT INTO RETSC_ADM_PAYMENT/,
    expectedAudits: 1,
    run: () => paymentRepo.createWithAudit(50, {
      paymentDate: '2026-11-20', amount: 100, currency: 'USD', method: 'TRANSFERENCIA', reference: null, bank: null,
    }, CTX, () => {}),
  },
  {
    name: 'admPaymentRepo.voidWithAudit',
    fn: 'payment.voidWithAudit',
    main: /UPDATE RETSC_ADM_PAYMENT/,
    expectedAudits: 1,
    run: () => paymentRepo.voidWithAudit(70, 'PRUEBA', CTX, () => {}),
  },
];

// Ayudas para leer los eventos anotados.
const idx = (type) => sim.events.findIndex((e) => e.type === type);
const has = (type) => sim.events.some((e) => e.type === type);
const auditQueries = () => sim.events.filter((e) => e.type === 'query' && /INSERT INTO RETSC_ADM_AUDIT_LOG/.test(e.text));

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------
describe('Bitácora completa en cada escritura', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      test('(1) la fila de bitácora se inserta por la MISMA transacción antes del commit', async () => {
        resetSim({ rows: c.rows ?? {} });
        await c.run();
        const audits = auditQueries();
        assert.equal(audits.length, c.expectedAudits, 'cantidad de filas de bitácora');
        assert.ok(audits.every((a) => a.via === 'transaction'), 'la bitácora debe ir por la transacción, no por el pool');
        // Todo lo que escribe va por la transacción.
        const writes = sim.events.filter((e) => e.type === 'query' && /\b(INSERT|UPDATE|DELETE)\b/.test(e.text));
        assert.ok(writes.every((w) => w.via === 'transaction'), 'hay una escritura fuera de la transacción');
        // Orden: begin < operación principal < bitácora < commit; y no hay rollback.
        const mainAt = sim.events.findIndex((e) => e.type === 'query' && c.main.test(e.text));
        const lastAuditAt = sim.events.lastIndexOf(audits.at(-1));
        assert.ok(idx('begin') === 0, 'begin debe ser lo primero');
        assert.ok(mainAt > 0 && mainAt < lastAuditAt, 'la bitácora va después de la operación principal');
        assert.ok(lastAuditAt < idx('commit'), 'la bitácora va antes del commit');
        assert.equal(has('rollback'), false);
      });

      test('(2) si la bitácora falla: rollback, sin commit, y el error llega a quien llamó', async () => {
        const auditError = new Error('INSERT de bitácora rechazado (simulado)');
        resetSim({ failOn: /INSERT INTO RETSC_ADM_AUDIT_LOG/, failError: auditError, rows: c.rows ?? {} });
        await assert.rejects(c.run(), (err) => err === auditError);
        assert.equal(has('commit'), false, 'no debe haber commit');
        assert.equal(has('rollback'), true, 'debe haber rollback');
      });

      test('(3) si la operación principal falla (2601): rollback, sin commit y sin bitácora', async () => {
        const dbError = uniqueViolation();
        resetSim({ failOn: c.main, failError: dbError, rows: c.rows ?? {} });
        await assert.rejects(c.run(), (err) => err === dbError);
        assert.equal(has('commit'), false, 'no debe haber commit');
        assert.equal(has('rollback'), true, 'debe haber rollback');
        assert.equal(auditQueries().length, 0, 'no debe haber fila de bitácora');
      });
    });
  }

  test('Cierre de OC: si falla el UPDATE de la OC, se deshace también la factura (rollback, sin commit)', async () => {
    const poError = new Error('UPDATE de OC rechazado (simulado)');
    resetSim({ failOn: /UPDATE RETSC_ADM_PURCHASE_ORDER/, failError: poError });
    await assert.rejects(invoiceRepo.createWithAudit({ ...INVOICE_REC, poId: 100 }, CTX, () => ({ closePo: true })), (e) => e === poError);
    assert.equal(has('commit'), false);
    assert.equal(has('rollback'), true);
  });

  test('Si una regla del servicio (checkLocked) rechaza: rollback, sin escritura ni bitácora', async () => {
    const rule = Object.assign(new Error('Regla de negocio'), { statusCode: 422 });
    for (const run of [
      () => invoiceRepo.createWithAudit(INVOICE_REC, CTX, () => { throw rule; }),
      () => invoiceRepo.changeStatusWithAudit(50, { status: 'ENVIADA' }, CTX, () => { throw rule; }),
      () => paymentRepo.createWithAudit(50, { paymentDate: '2026-11-20', amount: 1, currency: 'USD', method: 'OTRO' }, CTX, () => { throw rule; }),
      () => paymentRepo.voidWithAudit(70, 'PRUEBA', CTX, () => { throw rule; }),
    ]) {
      resetSim();
      await assert.rejects(run(), (e) => e === rule);
      assert.equal(has('commit'), false);
      assert.equal(has('rollback'), true);
      assert.equal(sim.events.filter((e) => e.type === 'query' && /\b(INSERT|UPDATE)\b/.test(e.text)).length, 0);
    }
  });
});

describe('Cobertura: ninguna función de escritura queda sin probar', () => {
  test('Toda función exportada que contiene INSERT/UPDATE/DELETE está en la lista de casos', () => {
    const covered = new Set(CASES.map((c) => c.fn));
    const repos = { contract: contractRepo, billing: billingRepo, invoice: invoiceRepo, payment: paymentRepo };
    const uncovered = [];
    for (const [prefix, repo] of Object.entries(repos)) {
      for (const [name, value] of Object.entries(repo)) {
        if (typeof value !== 'function') continue;
        if (/\b(INSERT|UPDATE|DELETE)\b/.test(value.toString()) && !covered.has(`${prefix}.${name}`)) {
          uncovered.push(`${prefix}.${name}`);
        }
      }
    }
    assert.deepEqual(uncovered, [], 'funciones de escritura sin prueba de bitácora');
  });

  test('Excepción documentada: admNoteRepo.create NO audita (la bitácora no admite la entidad NOTE)', async () => {
    // Se verifica el comportamiento real con la simulación: un INSERT simple por el pool, sin
    // transacción ni bitácora. Si algún día se agrega la entidad NOTE a la bitácora, esta prueba
    // debe cambiar para exigir la fila de bitácora.
    resetSim();
    // La simulación no tiene respuesta para la tabla de notas fuera de OUTPUT INSERTED; ese patrón la cubre.
    await noteRepo.create({ invoiceId: 50, note: 'PRUEBA', nextContactDate: null, userId: 1 });
    assert.equal(auditQueries().length, 0);
    assert.equal(has('begin'), false);
    const writes = sim.events.filter((e) => e.type === 'query');
    assert.equal(writes.length, 1);
    assert.match(writes[0].text, /INSERT INTO RETSC_ADM_COLLECTION_NOTE/);
  });
});
