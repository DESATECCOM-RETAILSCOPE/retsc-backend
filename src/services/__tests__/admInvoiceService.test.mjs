// Pruebas de admInvoiceService (facturas del módulo administrativo, paso 5).
//
// Qué se prueba: las reglas de negocio de facturas — moneda, total, OC obligatoria, estado
//   y empresa de la OC, saldo de la OC (y su cierre), número duplicado, plazo copiado del
//   contrato, transiciones de estado y anulación.
// Cómo: SIN base de datos. Los repositorios se reemplazan en require.cache por simulaciones
//   en memoria que imitan lo que hace el repositorio real dentro de la transacción: leen
//   el "estado bloqueado", llaman a checkLocked del servicio y, si no lanza, escriben.
//   (La parte SQL del repositorio no se prueba aquí; eso queda para pruebas_adm_paso5.sh en QA.)
// Correr: node --test src/services/__tests__/admInvoiceService.test.mjs
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
// Estado simulado de la "base" (se reinicia antes de cada prueba)
// ---------------------------------------------------------------------------
let db;
function resetDb() {
  db = {
    contracts: {
      // Contrato 10: empresa 35, USD, 30 días, sin OC obligatoria.
      10: { Contract_id: 10, Enterprise_id: 35, Status: 'ACTIVO', Currency: 'USD', Credit_days: 30, Requires_po: false },
      // Contrato 20: empresa 35, USD, 90 días, exige OC.
      20: { Contract_id: 20, Enterprise_id: 35, Status: 'ACTIVO', Currency: 'USD', Credit_days: 90, Requires_po: true },
      // Contrato 30: finalizado.
      30: { Contract_id: 30, Enterprise_id: 35, Status: 'FINALIZADO', Currency: 'USD', Credit_days: 30, Requires_po: false },
      // Contrato 40: otra empresa (36), exige OC.
      40: { Contract_id: 40, Enterprise_id: 36, Status: 'ACTIVO', Currency: 'USD', Credit_days: 60, Requires_po: true },
    },
    pos: {
      // OC 100: validada, empresa 35, contrato 20, monto 2000 USD.
      100: { PO_id: 100, Enterprise_id: 35, Contract_id: 20, Status: 'VALIDADA', Currency: 'USD', Amount: 2000 },
      // OC 101: en revisión (no validada).
      101: { PO_id: 101, Enterprise_id: 35, Contract_id: 20, Status: 'EN_REVISION', Currency: 'USD', Amount: 2000 },
      // OC 102: validada pero de otra empresa y contrato.
      102: { PO_id: 102, Enterprise_id: 36, Contract_id: 40, Status: 'VALIDADA', Currency: 'USD', Amount: 2000 },
    },
    invoices: [],
    payments: [],
    audit: [],
    nextInvoiceId: 1,
  };
}

// Suma una cantidad de días a 'AAAA-MM-DD' (en UTC, sin corrimientos). Imita el cálculo de
// la columna Due_date de la base: DATEADD(DAY, Credit_days, COALESCE(Received_date, Issue_date)).
const addDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Error como el que lanza mssql cuando se viola un índice único.
const uniqueError = (indexName) => {
  const e = new Error(`Cannot insert duplicate key row in object 'dbo.RETSC_ADM_INVOICE' with unique index '${indexName}'.`);
  e.number = 2601;
  return e;
};

// Contrato real: el servicio lo lee por id.
stub('repositories/admContractRepo.js', {
  findById: async (id) => db.contracts[id] ?? null,
});

// Repositorio de facturas simulado.
stub('repositories/admInvoiceRepo.js', {
  findById: async (id) => db.invoices.find((i) => i.Invoice_id === id) ?? null,
  listBalanceByEnterprise: async (enterpriseId, filters) => {
    db.lastListCall = { enterpriseId, filters };
    return [];
  },
  createWithAudit: async (rec, ctx, checkLocked) => {
    // 1. Lectura "bloqueada" de la OC y lo ya facturado contra ella (sin anuladas).
    const po = rec.poId != null ? (db.pos[rec.poId] ?? null) : null;
    const poInvoicedTotal = db.invoices
      .filter((i) => i.PO_id === rec.poId && i.Status !== 'ANULADA')
      .reduce((s, i) => s + i.Total_amount, 0);
    // 2. Reglas del servicio (si lanza, no se escribe nada = rollback).
    const { closePo } = (await checkLocked({ po, poInvoicedTotal })) || {};
    // 3. Índice único (Contract_id, Invoice_number), con colación que no distingue mayúsculas.
    if (db.invoices.some((i) => i.Contract_id === rec.contractId
      && i.Invoice_number.toUpperCase() === rec.invoiceNumber.toUpperCase())) {
      throw uniqueError('UX_ADM_INVOICE_NUMBER');
    }
    const row = {
      Invoice_id: db.nextInvoiceId++,
      Enterprise_id: rec.enterpriseId,
      Contract_id: rec.contractId,
      PO_id: rec.poId,
      Invoice_number: rec.invoiceNumber,
      Issue_date: rec.issueDate,
      Received_date: rec.receivedDate,
      Credit_days: rec.creditDays,
      Due_date: addDays(rec.receivedDate ?? rec.issueDate, rec.creditDays),
      Subtotal: rec.subtotal,
      Tax_amount: rec.taxAmount,
      Total_amount: rec.totalAmount,
      Currency: rec.currency,
      Status: 'REGISTRADA',
      Created_userid: ctx.userId,
    };
    db.invoices.push(row);
    db.audit.push({ entityType: 'INVOICE', action: 'CREATE', entityId: row.Invoice_id });
    // 5. Cierre de la OC.
    if (closePo && po) {
      db.audit.push({ entityType: 'PO', action: 'STATUS_CHANGE', entityId: po.PO_id, oldValue: { Status: po.Status }, newValue: { Status: 'CERRADA' } });
      po.Status = 'CERRADA';
    }
    return { row, poClosed: Boolean(closePo && po) };
  },
  changeStatusWithAudit: async (invoiceId, { status, voidReason }, ctx, checkLocked) => {
    const invoice = db.invoices.find((i) => i.Invoice_id === invoiceId);
    if (!invoice) { const e = new Error('Factura no encontrada.'); e.statusCode = 404; throw e; }
    const appliedTotal = db.payments
      .filter((p) => p.Invoice_id === invoiceId && p.Status === 'APLICADO')
      .reduce((s, p) => s + p.Amount, 0);
    await checkLocked({ invoice, appliedTotal });
    const old = invoice.Status;
    invoice.Status = status;
    if (status === 'ANULADA') invoice.Void_reason = voidReason;
    db.audit.push({ entityType: 'INVOICE', action: status === 'ANULADA' ? 'VOID' : 'STATUS_CHANGE', entityId: invoiceId, oldValue: { Status: old }, newValue: { Status: status } });
    return invoice;
  },
});

// El servicio se carga DESPUÉS de los stubs para que use las simulaciones.
const service = require(path.join(SRC, 'services', 'admInvoiceService.js'));

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------
const dtc = { userId: 1, enterpriseId: 2, roleName: 'ADMIN_DTC' };
const cliente = { userId: 59, enterpriseId: 35, roleName: 'ADMIN' };

// Cuerpo de factura válido (contrato 10, sin OC) que cada prueba ajusta.
const body = (over = {}) => ({
  contractId: 10,
  invoiceNumber: 'PRUEBA-001',
  issueDate: '2026-11-01',
  subtotal: 1000,
  taxAmount: 130,
  totalAmount: 1130,
  currency: 'USD',
  ...over,
});

// Ejecuta una promesa que debe fallar y devuelve { status, field } del error.
const failure = async (promise) => {
  try { await promise; } catch (e) { return { status: e.statusCode, field: e.payload?.field, message: e.message }; }
  assert.fail('se esperaba un error y la operación terminó bien');
};

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// Alta de factura
// ---------------------------------------------------------------------------
test('Alta válida: estado REGISTRADA, empresa del contrato y bitácora CREATE', async () => {
  // Se manda un enterpriseId falso en el cuerpo: debe ignorarse (la empresa sale del contrato).
  const { invoice, poClosed } = await service.create(dtc, body({ enterpriseId: 999 }), '1.2.3.4');
  assert.equal(invoice.status, 'REGISTRADA');
  assert.equal(invoice.enterpriseId, 35);
  assert.equal(poClosed, false);
  assert.deepEqual(db.audit.map((a) => `${a.entityType}:${a.action}`), ['INVOICE:CREATE']);
});

test('Plazo copiado del contrato y vencimiento desde la emisión si no hay recibido', async () => {
  const { invoice } = await service.create(dtc, body());
  assert.equal(invoice.creditDays, 30);
  assert.equal(invoice.dueDate, '2026-12-01');
});

test('Vencimiento desde la fecha de recibido cuando viene', async () => {
  const { invoice } = await service.create(dtc, body({ receivedDate: '2026-11-10' }));
  assert.equal(invoice.dueDate, '2026-12-10');
});

test('Moneda distinta a la del contrato -> 422 currency', async () => {
  const r = await failure(service.create(dtc, body({ currency: 'CRC' })));
  assert.deepEqual([r.status, r.field], [422, 'currency']);
});

test('Total que no cuadra con subtotal + impuesto -> 422 totalAmount', async () => {
  const r = await failure(service.create(dtc, body({ totalAmount: 1131 })));
  assert.deepEqual([r.status, r.field], [422, 'totalAmount']);
});

test('Total con decimales que sí cuadra (sin error de redondeo: 0.1 + 0.2 = 0.3)', async () => {
  const { invoice } = await service.create(dtc, body({ subtotal: 0.1, taxAmount: 0.2, totalAmount: 0.3 }));
  assert.equal(invoice.totalAmount, 0.3);
});

test('Contrato inexistente -> 422 contractId', async () => {
  const r = await failure(service.create(dtc, body({ contractId: 999 })));
  assert.deepEqual([r.status, r.field], [422, 'contractId']);
});

test('Contrato no ACTIVO -> 422 contractId', async () => {
  const r = await failure(service.create(dtc, body({ contractId: 30 })));
  assert.deepEqual([r.status, r.field], [422, 'contractId']);
});

test('Contrato que exige OC sin poId -> 422 poId', async () => {
  const r = await failure(service.create(dtc, body({ contractId: 20 })));
  assert.deepEqual([r.status, r.field], [422, 'poId']);
});

test('OC no VALIDADA -> 422 poId', async () => {
  const r = await failure(service.create(dtc, body({ contractId: 20, poId: 101 })));
  assert.deepEqual([r.status, r.field], [422, 'poId']);
});

test('OC de otra empresa y contrato -> 422 poId', async () => {
  const r = await failure(service.create(dtc, body({ contractId: 20, poId: 102 })));
  assert.deepEqual([r.status, r.field], [422, 'poId']);
});

test('OC inexistente -> 422 poId', async () => {
  const r = await failure(service.create(dtc, body({ contractId: 20, poId: 555 })));
  assert.deepEqual([r.status, r.field], [422, 'poId']);
});

test('Moneda distinta a la de la OC -> 422 currency', async () => {
  db.pos[100].Currency = 'CRC';
  // El contrato es USD, así que la factura en USD pasa el contrato pero choca con la OC.
  const r = await failure(service.create(dtc, body({ contractId: 20, poId: 100 })));
  assert.deepEqual([r.status, r.field], [422, 'currency']);
});

test('Saldo de la OC superado -> 422 totalAmount con el disponible en el mensaje', async () => {
  // Ya hay 1130 facturados contra la OC de 2000; otra de 1130 se pasa (2260 > 2000).
  await service.create(dtc, body({ contractId: 20, poId: 100, invoiceNumber: 'PRUEBA-A' }));
  const r = await failure(service.create(dtc, body({ contractId: 20, poId: 100, invoiceNumber: 'PRUEBA-B' })));
  assert.deepEqual([r.status, r.field], [422, 'totalAmount']);
  assert.match(r.message, /870\.00 USD/);
  assert.equal(db.invoices.length, 1);
});

test('Una factura ANULADA no cuenta para el saldo de la OC', async () => {
  await service.create(dtc, body({ contractId: 20, poId: 100, invoiceNumber: 'PRUEBA-A' }));
  db.invoices[0].Status = 'ANULADA';
  const { poClosed } = await service.create(dtc, body({ contractId: 20, poId: 100, invoiceNumber: 'PRUEBA-B' }));
  assert.equal(poClosed, false);
});

test('Factura que completa exactamente el monto: la OC pasa a CERRADA y se audita', async () => {
  await service.create(dtc, body({ contractId: 20, poId: 100, invoiceNumber: 'PRUEBA-A', subtotal: 1000, taxAmount: 0, totalAmount: 1000 }));
  assert.equal(db.pos[100].Status, 'VALIDADA');
  const { poClosed } = await service.create(dtc, body({ contractId: 20, poId: 100, invoiceNumber: 'PRUEBA-B', subtotal: 1000, taxAmount: 0, totalAmount: 1000 }));
  assert.equal(poClosed, true);
  assert.equal(db.pos[100].Status, 'CERRADA');
  const poAudit = db.audit.find((a) => a.entityType === 'PO');
  assert.deepEqual([poAudit.action, poAudit.oldValue.Status, poAudit.newValue.Status], ['STATUS_CHANGE', 'VALIDADA', 'CERRADA']);
  // Una OC CERRADA ya no admite más facturas.
  const r = await failure(service.create(dtc, body({ contractId: 20, poId: 100, invoiceNumber: 'PRUEBA-C', subtotal: 1, taxAmount: 0, totalAmount: 1 })));
  assert.deepEqual([r.status, r.field], [422, 'poId']);
});

test('Número duplicado en el contrato (error 2601 simulado) -> 422 invoiceNumber', async () => {
  await service.create(dtc, body());
  const r = await failure(service.create(dtc, body({ invoiceNumber: 'prueba-001' })));
  assert.deepEqual([r.status, r.field], [422, 'invoiceNumber']);
});

test('Fecha inexistente -> 422 issueDate', async () => {
  const r = await failure(service.create(dtc, body({ issueDate: '2026-02-31' })));
  assert.deepEqual([r.status, r.field], [422, 'issueDate']);
});

// ---------------------------------------------------------------------------
// Listado
// ---------------------------------------------------------------------------
test('Listado: el cliente usa su empresa del token; pedir otra -> 404', async () => {
  await service.list(cliente, {});
  assert.equal(db.lastListCall.enterpriseId, 35);
  const r = await failure(service.list(cliente, { enterpriseId: '36' }));
  assert.equal(r.status, 404);
});

test('Listado: DTC sin ?enterpriseId= -> 422; con filtros los pasa normalizados', async () => {
  const r = await failure(service.list(dtc, {}));
  assert.deepEqual([r.status, r.field], [422, 'enterpriseId']);
  await service.list(dtc, { enterpriseId: '36', status: 'enviada', currency: 'usd', overdue: '1', dueWithinDays: '7' });
  assert.deepEqual(db.lastListCall, {
    enterpriseId: 36,
    filters: { status: 'ENVIADA', currency: 'USD', overdue: true, dueWithinDays: 7 },
  });
});

test('Listado: filtros inválidos -> 422 con su campo', async () => {
  assert.equal((await failure(service.list(dtc, { enterpriseId: '36', overdue: 'si' }))).field, 'overdue');
  assert.equal((await failure(service.list(dtc, { enterpriseId: '36', status: 'ANULADA' }))).field, 'status');
  assert.equal((await failure(service.list(dtc, { enterpriseId: '36', dueWithinDays: '-1' }))).field, 'dueWithinDays');
});

// ---------------------------------------------------------------------------
// Cambio de estado
// ---------------------------------------------------------------------------
test('Transiciones válidas: REGISTRADA -> ENVIADA -> EN_DISPUTA -> ENVIADA (STATUS_CHANGE)', async () => {
  const { invoice } = await service.create(dtc, body());
  for (const status of ['ENVIADA', 'EN_DISPUTA', 'ENVIADA']) {
    const updated = await service.changeStatus(dtc, String(invoice.invoiceId), { status });
    assert.equal(updated.status, status);
  }
  assert.deepEqual(db.audit.slice(1).map((a) => a.action), ['STATUS_CHANGE', 'STATUS_CHANGE', 'STATUS_CHANGE']);
});

test('Transiciones inválidas: al mismo estado, a REGISTRADA y desde ANULADA -> 422 status', async () => {
  const { invoice } = await service.create(dtc, body());
  const id = String(invoice.invoiceId);
  await service.changeStatus(dtc, id, { status: 'ENVIADA' });
  assert.equal((await failure(service.changeStatus(dtc, id, { status: 'ENVIADA' }))).field, 'status');
  assert.equal((await failure(service.changeStatus(dtc, id, { status: 'REGISTRADA' }))).field, 'status');
  await service.changeStatus(dtc, id, { status: 'ANULADA', reason: 'Monto equivocado' });
  const r = await failure(service.changeStatus(dtc, id, { status: 'ENVIADA' }));
  assert.deepEqual([r.status, r.field], [422, 'status']);
});

test('Anular sin motivo -> 422 reason', async () => {
  const { invoice } = await service.create(dtc, body());
  const r = await failure(service.changeStatus(dtc, String(invoice.invoiceId), { status: 'ANULADA', reason: '   ' }));
  assert.deepEqual([r.status, r.field], [422, 'reason']);
});

test('Anular con motivo: queda ANULADA, guarda el motivo y audita VOID', async () => {
  const { invoice } = await service.create(dtc, body());
  const updated = await service.changeStatus(dtc, String(invoice.invoiceId), { status: 'ANULADA', reason: 'Duplicada' });
  assert.deepEqual([updated.status, updated.voidReason], ['ANULADA', 'Duplicada']);
  assert.equal(db.audit.at(-1).action, 'VOID');
});

test('Anular una factura con pagos APLICADO -> 422 status; con el pago anulado sí se puede', async () => {
  const { invoice } = await service.create(dtc, body());
  db.payments.push({ Payment_id: 1, Invoice_id: invoice.invoiceId, Amount: 500, Status: 'APLICADO' });
  const r = await failure(service.changeStatus(dtc, String(invoice.invoiceId), { status: 'ANULADA', reason: 'X' }));
  assert.deepEqual([r.status, r.field], [422, 'status']);
  db.payments[0].Status = 'ANULADO';
  const updated = await service.changeStatus(dtc, String(invoice.invoiceId), { status: 'ANULADA', reason: 'X' });
  assert.equal(updated.status, 'ANULADA');
});

test('Cambio de estado de una factura inexistente -> 404', async () => {
  const r = await failure(service.changeStatus(dtc, '999', { status: 'ENVIADA' }));
  assert.equal(r.status, 404);
});
