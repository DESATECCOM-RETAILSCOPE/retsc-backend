// Pruebas de admNoteService (notas de seguimiento de cobro, paso 6).
//
// Qué se prueba: alta de nota, límite de 500 caracteres, fecha inválida, factura inexistente
//   (404), listado más reciente primero, y que la ruta rechace a un usuario cliente (403).
// Cómo: SIN base de datos. Los repositorios se reemplazan en require.cache por simulaciones.
//   Para el 403 se carga el router real y se ejecuta el middleware de rol de la ruta.
// Correr: node --test src/services/__tests__/admNoteService.test.mjs
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

// "Base" simulada: una factura (id 1) y las notas guardadas.
let db;
beforeEach(() => {
  db = { invoices: { 1: { Invoice_id: 1, Status: 'REGISTRADA' } }, notes: [], nextId: 1 };
});

stub('repositories/admInvoiceRepo.js', {
  findById: async (id) => db.invoices[id] ?? null,
});
stub('repositories/admNoteRepo.js', {
  // Igual que el SQL real: más recientes (Note_id mayor) primero.
  listByInvoice: async (invoiceId) => db.notes.filter((n) => n.Invoice_id === invoiceId).sort((a, b) => b.Note_id - a.Note_id),
  create: async ({ invoiceId, note, nextContactDate, userId }) => {
    const row = {
      Note_id: db.nextId++, Invoice_id: invoiceId, Note: note,
      Next_contact_date: nextContactDate, Created_userid: userId, Created_at: new Date('2026-11-22T18:00:00Z'),
    };
    db.notes.push(row);
    return row;
  },
});

const service = require(path.join(SRC, 'services', 'admNoteService.js'));
const dtc = { userId: 1, enterpriseId: 2, roleName: 'ADMIN_DTC' };

const failure = async (promise) => {
  try { await promise; } catch (e) { return { status: e.statusCode, field: e.payload?.field }; }
  assert.fail('se esperaba un error y la operación terminó bien');
};

test('Alta de nota: guarda texto, fecha de próximo contacto y quién la creó', async () => {
  const note = await service.create(dtc, '1', { note: '  PRUEBA llamé a cobros  ', nextContactDate: '2026-11-25' });
  assert.deepEqual(note, {
    noteId: 1, invoiceId: 1, note: 'PRUEBA llamé a cobros', nextContactDate: '2026-11-25',
    createdUserId: 1, createdAt: '2026-11-22T18:00:00.000Z',
  });
});

test('Alta sin fecha de próximo contacto: queda null', async () => {
  const note = await service.create(dtc, '1', { note: 'PRUEBA sin fecha' });
  assert.equal(note.nextContactDate, null);
});

test('Nota de 500 caracteres pasa; de 501 -> 422 note; vacía -> 422 note', async () => {
  await service.create(dtc, '1', { note: 'x'.repeat(500) });
  assert.deepEqual(await failure(service.create(dtc, '1', { note: 'x'.repeat(501) })), { status: 422, field: 'note' });
  assert.deepEqual(await failure(service.create(dtc, '1', { note: '   ' })), { status: 422, field: 'note' });
});

test('Fecha de próximo contacto inválida -> 422 nextContactDate', async () => {
  assert.deepEqual(await failure(service.create(dtc, '1', { note: 'PRUEBA', nextContactDate: '2026-02-30' })), { status: 422, field: 'nextContactDate' });
  assert.deepEqual(await failure(service.create(dtc, '1', { note: 'PRUEBA', nextContactDate: '22/11/2026' })), { status: 422, field: 'nextContactDate' });
});

test('Factura inexistente -> 404 al crear y al listar; no se guarda nada', async () => {
  assert.equal((await failure(service.create(dtc, '999', { note: 'PRUEBA' }))).status, 404);
  assert.equal((await failure(service.listByInvoice('999'))).status, 404);
  assert.equal(db.notes.length, 0);
});

test('Listado: más recientes primero', async () => {
  await service.create(dtc, '1', { note: 'PRUEBA primera' });
  await service.create(dtc, '1', { note: 'PRUEBA segunda' });
  const list = await service.listByInvoice('1');
  assert.deepEqual(list.map((n) => n.note), ['PRUEBA segunda', 'PRUEBA primera']);
});

test('Rutas de notas: un usuario cliente recibe 403 y DTC pasa', async () => {
  // Se carga el router real; las rutas de notas usan el middleware dtcOnly como primer paso.
  const router = require(path.join(SRC, 'routes', 'admRoutes.js'));
  for (const method of ['get', 'post']) {
    const layer = router.stack.find((l) => l.route?.path === '/invoices/:id/notes' && l.route.methods[method]);
    assert.ok(layer, `falta la ruta ${method.toUpperCase()} /invoices/:id/notes`);
    const roleCheck = layer.route.stack[0].handle;

    // Usuario cliente (ADMIN de su empresa): 403 y no sigue.
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nextCalled = false;
    roleCheck({ user: { userId: 59, enterpriseId: 35, roleName: 'ADMIN' } }, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);

    // ADMIN_DTC: sigue al controlador.
    let dtcNext = false;
    roleCheck({ user: dtc }, res, () => { dtcNext = true; });
    assert.equal(dtcNext, true);
  }
});
