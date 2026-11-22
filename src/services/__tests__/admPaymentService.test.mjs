// Pruebas de admPaymentService (pagos de facturas del módulo administrativo, paso 5).
//
// Qué se prueba: pago parcial, pago exacto (PAGADA), pago que excede el saldo, pago en otra
//   moneda, pago a factura ANULADA, anular un pago y volver a pagar, anular un pago ya anulado.
// Cómo: SIN base de datos. Los repositorios se reemplazan en require.cache por simulaciones
//   en memoria que imitan la transacción real: leen la factura "bloqueada" y la suma de pagos
//   APLICADO, llaman a checkLocked del servicio y, si no lanza, escriben y calculan el saldo
//   como lo hace la vista RETSC_ADM_V_INVOICE_BALANCE.
// Correr: node --test src/services/__tests__/admPaymentService.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');
// Reemplaza un módulo por un objeto propio antes de que el servicio lo cargue.
const stub = (p, exportsObj) => {
  const id = require.resolve(path.join(SRC, p));
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
};

// ---------------------------------------------------------------------------
// Estado simulado de la "base"
// ---------------------------------------------------------------------------
let db;
function resetDb() {
  db = {
    invoices: {
      // Factura 1: 1130 USD, REGISTRADA.
      1: { Invoice_id: 1, Total_amount: 1130, Currency: 'USD', Status: 'REGISTRADA' },
      // Factura 2: ANULADA.
      2: { Invoice_id: 2, Total_amount: 500, Currency: 'USD', Status: 'ANULADA', Void_reason: 'Duplicada' },
    },
    payments: [],
    audit: [],
    nextPaymentId: 1,
  };
}

// Suma de pagos APLICADO de una factura (igual que la consulta del repositorio real).
const appliedTotal = (invoiceId) => db.payments
  .filter((p) => p.Invoice_id === invoiceId && p.Status === 'APLICADO')
  .reduce((s, p) => s + Math.round(p.Amount * 100), 0) / 100;

// Imita una fila de RETSC_ADM_V_INVOICE_BALANCE (null para facturas ANULADA, que la vista excluye).
const balanceRow = (invoiceId) => {
  const inv = db.invoices[invoiceId];
  if (!inv || inv.Status === 'ANULADA') return null;
  const paid = appliedTotal(invoiceId);
  const balance = Math.round((inv.Total_amount - paid) * 100) / 100;
  const status = paid === 0 ? 'PENDIENTE' : balance === 0 ? 'PAGADA' : 'PARCIAL';
  return { Invoice_id: invoiceId, Total_amount: inv.Total_amount, Paid_total: paid, Balance: balance, Payment_status: status };
};

stub('repositories/admInvoiceRepo.js', {
  findById: async (id) => db.invoices[id] ?? null,
});

stub('repositories/admPaymentRepo.js', {
  listByInvoice: async (invoiceId) => db.payments.filter((p) => p.Invoice_id === invoiceId),
  createWithAudit: async (invoiceId, rec, ctx, checkLocked) => {
    const invoice = db.invoices[invoiceId];
    if (!invoice) { const e = new Error('Factura no encontrada.'); e.statusCode = 404; throw e; }
    await checkLocked({ invoice, appliedTotal: appliedTotal(invoiceId) });
    const row = {
      Payment_id: db.nextPaymentId++,
      Invoice_id: invoiceId,
      Payment_date: rec.paymentDate,
      Amount: rec.amount,
      Currency: rec.currency,
      Method: rec.method,
      Reference: rec.reference,
      Bank: rec.bank,
      Source: 'MANUAL',
      Status: 'APLICADO',
      Recorded_userid: ctx.userId,
    };
    db.payments.push(row);
    db.audit.push({ entityType: 'PAYMENT', action: 'CREATE', entityId: row.Payment_id });
    return { row, balance: balanceRow(invoiceId) };
  },
  voidWithAudit: async (paymentId, reason, ctx, checkLocked) => {
    const payment = db.payments.find((p) => p.Payment_id === paymentId);
    if (!payment) { const e = new Error('Pago no encontrado.'); e.statusCode = 404; throw e; }
    await checkLocked({ payment });
    payment.Status = 'ANULADO';
    payment.Void_reason = reason;
    db.audit.push({ entityType: 'PAYMENT', action: 'VOID', entityId: paymentId });
    return { row: payment, balance: balanceRow(payment.Invoice_id) };
  },
});

// El servicio se carga DESPUÉS de los stubs para que use las simulaciones.
const service = require(path.join(SRC, 'services', 'admPaymentService.js'));

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------
const dtc = { userId: 1, enterpriseId: 2, roleName: 'ADMIN_DTC' };
const pago = (over = {}) => ({ paymentDate: '2026-11-20', amount: 500, currency: 'USD', method: 'TRANSFERENCIA', reference: 'TRX-1', ...over });

const failure = async (promise) => {
  try { await promise; } catch (e) { return { status: e.statusCode, field: e.payload?.field, message: e.message }; }
  assert.fail('se esperaba un error y la operación terminó bien');
};

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------
test('Pago parcial: APLICADO, MANUAL, saldo 630 y PARCIAL; audita CREATE', async () => {
  const { payment, invoiceBalance } = await service.create(dtc, '1', pago());
  assert.deepEqual([payment.status, payment.source, payment.recordedUserId], ['APLICADO', 'MANUAL', 1]);
  assert.deepEqual([invoiceBalance.paidTotal, invoiceBalance.balance, invoiceBalance.paymentStatus], [500, 630, 'PARCIAL']);
  assert.deepEqual(db.audit, [{ entityType: 'PAYMENT', action: 'CREATE', entityId: 1 }]);
});

test('Pago exacto del saldo: PAGADA con saldo 0', async () => {
  await service.create(dtc, '1', pago());
  const { invoiceBalance } = await service.create(dtc, '1', pago({ amount: 630 }));
  assert.deepEqual([invoiceBalance.balance, invoiceBalance.paymentStatus], [0, 'PAGADA']);
});

test('Pago que excede el saldo -> 422 amount con el saldo pendiente en el mensaje', async () => {
  await service.create(dtc, '1', pago());
  const r = await failure(service.create(dtc, '1', pago({ amount: 700 })));
  assert.deepEqual([r.status, r.field], [422, 'amount']);
  assert.match(r.message, /630\.00 USD/);
  assert.equal(db.payments.length, 1);
});

test('Pago con decimales que llega justo al total no se rechaza por redondeo', async () => {
  db.invoices[1].Total_amount = 0.3;
  await service.create(dtc, '1', pago({ amount: 0.1 }));
  const { invoiceBalance } = await service.create(dtc, '1', pago({ amount: 0.2 }));
  assert.equal(invoiceBalance.paymentStatus, 'PAGADA');
});

test('Pago en otra moneda -> 422 currency', async () => {
  const r = await failure(service.create(dtc, '1', pago({ currency: 'CRC' })));
  assert.deepEqual([r.status, r.field], [422, 'currency']);
});

test('Pago a una factura ANULADA -> 422 status', async () => {
  const r = await failure(service.create(dtc, '2', pago()));
  assert.deepEqual([r.status, r.field], [422, 'status']);
});

test('Pago a una factura inexistente -> 404', async () => {
  const r = await failure(service.create(dtc, '999', pago()));
  assert.equal(r.status, 404);
});

test('Validaciones de formato: monto 0, 3 decimales, método inválido, referencia larga', async () => {
  assert.equal((await failure(service.create(dtc, '1', pago({ amount: 0 })))).field, 'amount');
  assert.equal((await failure(service.create(dtc, '1', pago({ amount: 10.555 })))).field, 'amount');
  assert.equal((await failure(service.create(dtc, '1', pago({ method: 'CHEQUE' })))).field, 'method');
  assert.equal((await failure(service.create(dtc, '1', pago({ reference: 'x'.repeat(101) })))).field, 'reference');
  assert.equal((await failure(service.create(dtc, '1', pago({ paymentDate: undefined })))).field, 'paymentDate');
});

test('Anular un pago y volver a pagar: el saldo se recupera y admite un nuevo pago', async () => {
  await service.create(dtc, '1', pago());
  const { payment: p2, invoiceBalance: full } = await service.create(dtc, '1', pago({ amount: 630 }));
  assert.equal(full.paymentStatus, 'PAGADA');

  const { payment, invoiceBalance } = await service.voidPayment(dtc, String(p2.paymentId), { reason: 'Transferencia rebotada' });
  assert.deepEqual([payment.status, payment.voidReason], ['ANULADO', 'Transferencia rebotada']);
  assert.deepEqual([invoiceBalance.balance, invoiceBalance.paymentStatus], [630, 'PARCIAL']);
  assert.equal(db.audit.at(-1).action, 'VOID');

  const again = await service.create(dtc, '1', pago({ amount: 630 }));
  assert.equal(again.invoiceBalance.paymentStatus, 'PAGADA');
});

test('Anular un pago ya ANULADO -> 422 status', async () => {
  const { payment } = await service.create(dtc, '1', pago());
  await service.voidPayment(dtc, String(payment.paymentId), { reason: 'Error' });
  const r = await failure(service.voidPayment(dtc, String(payment.paymentId), { reason: 'Otra vez' }));
  assert.deepEqual([r.status, r.field], [422, 'status']);
});

test('Anular un pago sin motivo -> 422 reason', async () => {
  const { payment } = await service.create(dtc, '1', pago());
  const r = await failure(service.voidPayment(dtc, String(payment.paymentId), {}));
  assert.deepEqual([r.status, r.field], [422, 'reason']);
});

test('Anular un pago inexistente -> 404', async () => {
  const r = await failure(service.voidPayment(dtc, '999', { reason: 'X' }));
  assert.equal(r.status, 404);
});

test('Listar pagos: incluye APLICADO y ANULADO; factura inexistente -> 404', async () => {
  const { payment } = await service.create(dtc, '1', pago());
  await service.voidPayment(dtc, String(payment.paymentId), { reason: 'X' });
  await service.create(dtc, '1', pago({ amount: 100 }));
  const list = await service.listByInvoice('1');
  assert.deepEqual(list.map((p) => p.status), ['ANULADO', 'APLICADO']);
  assert.equal((await failure(service.listByInvoice('999'))).status, 404);
});
