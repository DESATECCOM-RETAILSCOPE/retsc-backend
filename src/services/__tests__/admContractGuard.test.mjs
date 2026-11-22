// Pruebas del guardia de admContractService.update (paso 6): no se puede cambiar la MONEDA de
// un contrato que ya tiene facturas; el plazo sí se puede cambiar.
//
// Cómo: SIN base de datos. Los repositorios se reemplazan en require.cache por simulaciones.
// Además se prueba que las rutas nuevas del paso 6 (aging, receivables, audit) rechazan a un
// usuario cliente con 403.
// Correr: node --test src/services/__tests__/admContractGuard.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');
const stub = (p, exportsObj) => {
  const id = require.resolve(path.join(SRC, p));
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
};

// "Base" simulada: el contrato 10 (USD, 30 días) y cuántas facturas tiene.
let contract;
let invoiceCount;
let updates;
beforeEach(() => {
  contract = {
    Contract_id: 10, Enterprise_id: 35, Plan_code: 'PRUEBA', Status: 'ACTIVO',
    Start_date: new Date('2026-01-01T00:00:00Z'), End_date: null, Billing_frequency: 'MENSUAL',
    Amount_per_period: 4500, Currency: 'USD', Payment_method: 'OC_FACTURA', Credit_days: 30,
    Requires_po: false, Issuer_name: null, Created_at: new Date('2026-01-01T00:00:00Z'), Created_userid: 1,
  };
  invoiceCount = 0;
  updates = [];
});

stub('repositories/admContractRepo.js', {
  findById: async (id) => (id === 10 ? contract : null),
  countInvoices: async () => invoiceCount,
  updateWithAudit: async (id, changes) => {
    updates.push(changes);
    return { ...contract, ...changes };
  },
});
stub('repositories/admEnterpriseRepo.js', { exists: async () => true });

const service = require(path.join(SRC, 'services', 'admContractService.js'));
const dtc = { userId: 1, enterpriseId: 2, roleName: 'ADMIN_DTC' };

const failure = async (promise) => {
  try { await promise; } catch (e) { return { status: e.statusCode, field: e.payload?.field }; }
  assert.fail('se esperaba un error y la operación terminó bien');
};

test('Cambiar la moneda de un contrato CON facturas (aunque sea una ANULADA) -> 422 currency', async () => {
  invoiceCount = 1; // countInvoices cuenta cualquier estado, ANULADA incluida.
  assert.deepEqual(await failure(service.update(dtc, '10', { currency: 'CRC' })), { status: 422, field: 'currency' });
  assert.equal(updates.length, 0, 'no debe escribir nada');
});

test('Cambiar la moneda de un contrato SIN facturas -> permitido', async () => {
  invoiceCount = 0;
  const updated = await service.update(dtc, '10', { currency: 'CRC' });
  assert.equal(updated.currency, 'CRC');
  assert.deepEqual(updates, [{ Currency: 'CRC' }]);
});

test('Cambiar el plazo de un contrato CON facturas -> permitido', async () => {
  invoiceCount = 3;
  const updated = await service.update(dtc, '10', { creditDays: 60 });
  assert.equal(updated.creditDays, 60);
  assert.deepEqual(updates, [{ Credit_days: 60 }]);
});

test('Cambiar el método de pago de un contrato CON facturas -> permitido (la spec no lo define)', async () => {
  invoiceCount = 3;
  const updated = await service.update(dtc, '10', { paymentMethod: 'PASARELA', creditDays: 0 });
  assert.equal(updated.paymentMethod, 'PASARELA');
});

test('Mandar la MISMA moneda con facturas no cuenta como cambio: no se rechaza', async () => {
  invoiceCount = 3;
  const updated = await service.update(dtc, '10', { currency: 'usd', planCode: 'PRUEBA-2' });
  assert.equal(updated.planCode, 'PRUEBA-2');
  assert.deepEqual(updates, [{ Plan_code: 'PRUEBA-2' }]);
});

test('Rutas del paso 6 (aging, receivables, audit): cliente -> 403, DTC pasa', () => {
  const router = require(path.join(SRC, 'routes', 'admRoutes.js'));
  for (const routePath of ['/aging', '/receivables', '/audit']) {
    const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods.get);
    assert.ok(layer, `falta la ruta GET ${routePath}`);
    const roleCheck = layer.route.stack[0].handle;
    for (const roleName of ['ADMIN', 'GERENCIA']) {
      const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      let nextCalled = false;
      roleCheck({ user: { userId: 59, enterpriseId: 35, roleName } }, res, () => { nextCalled = true; });
      assert.equal(res.statusCode, 403, `${roleName} en ${routePath}`);
      assert.equal(nextCalled, false);
    }
    let dtcNext = false;
    roleCheck({ user: dtc }, {}, () => { dtcNext = true; });
    assert.equal(dtcNext, true, `DTC en ${routePath}`);
  }
});
