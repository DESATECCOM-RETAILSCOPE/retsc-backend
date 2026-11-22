// Pruebas de admAuditService (consulta de bitácora, paso 6).
//
// Qué se prueba: cada filtro, el límite (por defecto y máximo), beforeId y nextBeforeId,
//   entityType inválido (422), el enmascarado de datos personales (incluso anidado), JSON roto,
//   y que no se pida ni se devuelva nada de contraseñas.
// Cómo: SIN base de datos. El repositorio se reemplaza en require.cache por una simulación;
//   la función pura buildListQuery del repositorio real se usa para revisar el texto SQL.
// Correr: node --test src/services/__tests__/admAuditService.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');

// Repositorio REAL solo para su función pura (no se conecta a la base).
const realRepo = require(path.join(SRC, 'repositories', 'admAuditQueryRepo.js'));

const stub = (p, exportsObj) => {
  const id = require.resolve(path.join(SRC, p));
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
};

let lastFilters;
let rows;
beforeEach(() => { lastFilters = null; rows = []; });
stub('repositories/admAuditQueryRepo.js', {
  list: async (filters) => { lastFilters = filters; return rows; },
});

const service = require(path.join(SRC, 'services', 'admAuditService.js'));

const failure = async (promise) => {
  try { await promise; } catch (e) { return { status: e.statusCode, field: e.payload?.field }; }
  assert.fail('se esperaba un error y la operación terminó bien');
};

// Fila de bitácora como la devolvería la base. Audit_id es bigint (mssql lo puede dar como texto).
const auditRow = (id, over = {}) => ({
  Audit_id: String(id), Entity_type: 'INVOICE', Entity_id: 7, Action: 'CREATE',
  Old_value: null, New_value: '{"Invoice_number":"PRUEBA-1"}', User_id: 1, User_name: 'dtc.admin',
  Created_at: new Date('2026-11-22T18:00:00Z'), Ip_address: '10.0.0.1', ...over,
});

// ---------------------------------------------------------------------------
// Filtros y paginación
// ---------------------------------------------------------------------------
test('Sin filtros: límite 50 y todo lo demás en null', async () => {
  await service.list({});
  assert.deepEqual(lastFilters, {
    entityType: null, entityId: null, action: null, userId: null,
    from: null, to: null, beforeId: null, limit: 50,
  });
});

test('Cada filtro llega normalizado al repositorio', async () => {
  await service.list({
    entityType: 'invoice', entityId: '7', action: 'status_change', userId: '3',
    from: '2026-11-01', to: '2026-11-22', beforeId: '120', limit: '10',
  });
  assert.deepEqual(lastFilters, {
    entityType: 'INVOICE', entityId: 7, action: 'STATUS_CHANGE', userId: 3,
    from: '2026-11-01', to: '2026-11-22', beforeId: 120, limit: 10,
  });
});

test('entityType inválido (NOTE) -> 422 entityType; otros filtros inválidos -> 422 con su campo', async () => {
  assert.deepEqual(await failure(service.list({ entityType: 'NOTE' })), { status: 422, field: 'entityType' });
  assert.deepEqual(await failure(service.list({ action: 'DELETE' })), { status: 422, field: 'action' });
  assert.deepEqual(await failure(service.list({ entityId: 'x' })), { status: 422, field: 'entityId' });
  assert.deepEqual(await failure(service.list({ from: '2026-13-01' })), { status: 422, field: 'from' });
  assert.deepEqual(await failure(service.list({ from: '2026-11-22', to: '2026-11-01' })), { status: 422, field: 'to' });
  assert.deepEqual(await failure(service.list({ limit: '0' })), { status: 422, field: 'limit' });
  assert.deepEqual(await failure(service.list({ beforeId: '-5' })), { status: 422, field: 'beforeId' });
});

test('Límite máximo: 500 se recorta a 200; 200 se respeta', async () => {
  await service.list({ limit: '500' });
  assert.equal(lastFilters.limit, 200);
  await service.list({ limit: '200' });
  assert.equal(lastFilters.limit, 200);
});

test('nextBeforeId: con página llena es el último id; con página incompleta es null', async () => {
  rows = [auditRow(120), auditRow(119)];
  const full = await service.list({ limit: '2' });
  assert.deepEqual(full.entries.map((e) => e.auditId), [120, 119]);
  assert.equal(full.nextBeforeId, 119);
  rows = [auditRow(118)];
  const last = await service.list({ limit: '2', beforeId: '119' });
  assert.equal(lastFilters.beforeId, 119);
  assert.equal(last.nextBeforeId, null);
});

test('SQL: filtros parametrizados, fechas en hora de Costa Rica, beforeId y orden', () => {
  const { text, params } = realRepo.buildListQuery({
    entityType: 'INVOICE', entityId: 7, action: 'VOID', userId: 3,
    from: '2026-11-01', to: '2026-11-22', beforeId: 120, limit: 10,
  });
  assert.match(text, /SELECT TOP \(@limit\)/);
  assert.match(text, /a\.Entity_type = @entityType AND a\.Entity_id = @entityId AND a\.Action = @action AND a\.User_id = @userId/);
  // Día "from" en Costa Rica empieza a las 06:00 UTC; día "to" termina antes de las 06:00 UTC del día siguiente.
  assert.match(text, /a\.Created_at >= DATEADD\(HOUR, 6, CAST\(@from AS datetime2\(0\)\)\)/);
  assert.match(text, /a\.Created_at < DATEADD\(HOUR, 6, DATEADD\(DAY, 1, CAST\(@to AS datetime2\(0\)\)\)\)/);
  assert.match(text, /a\.Audit_id < @beforeId/);
  assert.match(text, /ORDER BY a\.Audit_id DESC/);
  assert.deepEqual(params.map((p) => p.name).sort(), ['action', 'beforeId', 'entityId', 'entityType', 'from', 'limit', 'to', 'userId']);
  // Sin filtros no hay WHERE.
  assert.doesNotMatch(realRepo.buildListQuery({ limit: 50 }).text, /WHERE/);
});

// ---------------------------------------------------------------------------
// Datos personales y contraseñas
// ---------------------------------------------------------------------------
test('SQL: de usuarios solo se piden User_id (JOIN) y User_name; nada de contraseñas', () => {
  const { text } = realRepo.buildListQuery({ limit: 50 });
  assert.doesNotMatch(text, /password|hash|Email|ced_identidad/i);
  assert.doesNotMatch(text, /u\.\*/);
  // Las únicas columnas de "u" que aparecen son User_name (en el SELECT) y User_id (en el JOIN).
  const userColumns = [...text.matchAll(/\bu\.(\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(userColumns)], ['User_id', 'User_name']);
});

test('Respuesta: aunque la fila trajera columnas de contraseña, el DTO no las devuelve', async () => {
  rows = [auditRow(1, { PasswordHash: '$2a$10$secreto', Email: 'x@y.com' })];
  const { entries } = await service.list({});
  assert.deepEqual(Object.keys(entries[0]).sort(), [
    'action', 'auditId', 'createdAt', 'entityId', 'entityType', 'ipAddress', 'newValue', 'oldValue', 'userId', 'userName',
  ]);
  assert.doesNotMatch(JSON.stringify(entries), /secreto|x@y\.com/);
});

test('Enmascarado: las cuatro claves, a cualquier nivel y en arreglos; el resto queda igual', async () => {
  rows = [auditRow(1, {
    Entity_type: 'BILLING_PROFILE',
    Old_value: JSON.stringify({ Billing_email: 'viejo@cliente.com', Country: 'CR' }),
    New_value: JSON.stringify({
      Legal_name: 'EMPRESA S.A.', Tax_id: '3-101-000000', Billing_address: 'San José', Billing_email: 'nuevo@cliente.com',
      Country: 'CR',
      anidado: { perfil: { Tax_id: '1', billingEmail: 'camel@cliente.com' } },
      lista: [{ Legal_name: 'OTRA' }, 5],
    }),
  })];
  const [entry] = (await service.list({})).entries;
  assert.deepEqual(entry.oldValue, { Billing_email: '***', Country: 'CR' });
  assert.deepEqual(entry.newValue, {
    Legal_name: '***', Tax_id: '***', Billing_address: '***', Billing_email: '***',
    Country: 'CR',
    anidado: { perfil: { Tax_id: '***', billingEmail: '***' } },
    lista: [{ Legal_name: '***' }, 5],
  });
  assert.doesNotMatch(JSON.stringify(entry), /cliente\.com|3-101|San José|EMPRESA S\.A\./);
});

test('JSON roto -> "[no se pudo leer]" (nunca el texto crudo); null se queda null', async () => {
  rows = [auditRow(1, { Old_value: '{"Tax_id": "3-101-000000"', New_value: null })];
  const [entry] = (await service.list({})).entries;
  assert.equal(entry.oldValue, '[no se pudo leer]');
  assert.equal(entry.newValue, null);
});

test('DTO completo de una fila normal', async () => {
  rows = [auditRow(5)];
  const [entry] = (await service.list({})).entries;
  assert.deepEqual(entry, {
    auditId: 5, entityType: 'INVOICE', entityId: 7, action: 'CREATE',
    oldValue: null, newValue: { Invoice_number: 'PRUEBA-1' }, userId: 1, userName: 'dtc.admin',
    createdAt: '2026-11-22T18:00:00.000Z', ipAddress: '10.0.0.1',
  });
});
