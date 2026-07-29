// Test del guard anti-escalada a ADMIN_DTC (userService.assertCanAssignRole).
//
// NO toca la BD: stubea src/config/db.js, roleRepo, userRepo, userEnterpriseRepo
// y utils/mailer vía require.cache ANTES de requerir userService. El .env de
// este repo apunta a producción (sql-rscope-prod) — este script existe
// precisamente para poder validar la lógica del guard sin conexión real.
//
// Los repos de escritura (userRepo.insert, userRepo.update,
// userEnterpriseRepo.update) lanzan un error reconocible (code
// LLEGO_AL_INSERT) en vez de simular la escritura — así se distingue "el
// guard dejó pasar y el flujo llegó al insert" de "el guard bloqueó antes de
// llegar ahí" sin necesitar una base de datos real.
//
// Correr: node scripts/test-user-role-gates.js

'use strict';

const path = require('path');

function stub(absolutePath, exportsObj) {
  const resolved = require.resolve(absolutePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
  };
}

const SRC = path.join(__dirname, '..', 'src');

// ─── Fixtures de roles ──────────────────────────────────────────────────────
const ROLE_ADMIN     = { Role_id: 1, Role_name: 'ADMIN' };
const ROLE_ADMIN_DTC = { Role_id: 2, Role_name: 'ADMIN_DTC' };
const ROLE_EJECUTIVO = { Role_id: 3, Role_name: 'EJECUTIVO CAMPO' };
const ROLES_BY_ID = { 1: ROLE_ADMIN, 2: ROLE_ADMIN_DTC, 3: ROLE_EJECUTIVO };

// ─── Stub src/config/db.js — si algo intenta tocar la BD, esto debe fallar ──
stub(path.join(SRC, 'config', 'db.js'), {
  getPool: async () => { throw new Error('DB_NO_DEBE_TOCARSE: este test no debería requerir conexión a MSSQL'); },
  sql: new Proxy({}, { get() { throw new Error('DB_NO_DEBE_TOCARSE'); } }),
});

// ─── Stub src/repositories/roleRepo.js ──────────────────────────────────────
stub(path.join(SRC, 'repositories', 'roleRepo.js'), {
  findById: async (id) => ROLES_BY_ID[Number(id)] ?? null,
  findByName: async () => { throw new Error('NO_USADO_EN_ESTOS_TESTS'); },
  listAll: async () => Object.values(ROLES_BY_ID),
  insert: async () => { throw new Error('NO_USADO_EN_ESTOS_TESTS'); },
  update: async () => { throw new Error('NO_USADO_EN_ESTOS_TESTS'); },
});

// ─── Stub src/repositories/userRepo.js ──────────────────────────────────────
function llegoAlInsert() {
  const e = new Error('LLEGO_AL_INSERT');
  e.code = 'LLEGO_AL_INSERT';
  throw e;
}
stub(path.join(SRC, 'repositories', 'userRepo.js'), {
  findById:     async () => null,
  findByEmail:  async () => null,  // nunca hay colisión de email en estos tests
  findByCedula: async () => null,  // nunca hay reactivación — siempre alta nueva
  listAll:      async () => [],
  insert:       async () => llegoAlInsert(),
  update:       async () => llegoAlInsert(),
  remove:       async () => true,
});

// ─── Stub src/repositories/userEnterpriseRepo.js ────────────────────────────
stub(path.join(SRC, 'repositories', 'userEnterpriseRepo.js'), {
  findActiveByUserId: async () => [],
  findByEnterprise:   async () => [],
  findByUserAndEnterprise: async (userId, enterpriseId) => ({
    User_id: userId, Enterprise_id: enterpriseId, Role_id: ROLE_EJECUTIVO.Role_id, Status: 1,
  }),
  insert: async () => llegoAlInsert(),
  update: async () => llegoAlInsert(),
});

// ─── Stub src/utils/mailer.js ────────────────────────────────────────────────
stub(path.join(SRC, 'utils', 'mailer.js'), {
  sendMail: async () => ({ mode: 'stub' }),
});

const userService = require(path.join(SRC, 'services', 'userService.js'));

// ─── Helpers ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ FAIL: ${msg}`); failed++; }

async function expectPass(fn, label) {
  try {
    await fn();
    fail(`${label} → se esperaba que el guard dejara pasar, pero no llegó al insert`);
  } catch (err) {
    if (err.code === 'LLEGO_AL_INSERT') ok(`${label} → pasó el guard (llegó al insert)`);
    else fail(`${label} → error inesperado: ${err.statusCode ?? 'sin status'} ${err.message}`);
  }
}

async function expect403(fn, label) {
  try {
    await fn();
    fail(`${label} → se esperaba 403 pero no lanzó nada`);
  } catch (err) {
    if (err.statusCode === 403) ok(`${label} → bloqueado con 403 ("${err.message}")`);
    else fail(`${label} → esperaba 403, obtuvo ${err.statusCode ?? 'sin status'} (${err.message})`);
  }
}

let cedulaSeq = 100000000;
function newPayload(roleId) {
  cedulaSeq++;
  return {
    cedIdentidad: String(cedulaSeq),
    userName: 'Test User',
    email: `test${cedulaSeq}@example.com`,
    password: 'password123',
    roleId,
  };
}

(async () => {
  console.log('\n── Guard anti-escalada a ADMIN_DTC (userService.assertCanAssignRole) ──\n');

  await expect403(
    () => userService.createAndAssign(newPayload(ROLE_ADMIN_DTC.Role_id), 1, 'ADMIN'),
    'ADMIN crea un ADMIN_DTC',
  );
  await expectPass(
    () => userService.createAndAssign(newPayload(ROLE_ADMIN_DTC.Role_id), 1, 'ADMIN_DTC'),
    'ADMIN_DTC crea un ADMIN_DTC',
  );
  await expectPass(
    () => userService.createAndAssign(newPayload(ROLE_ADMIN.Role_id), 1, 'ADMIN'),
    'ADMIN crea un ADMIN normal',
  );
  await expectPass(
    () => userService.createAndAssign(newPayload(ROLE_EJECUTIVO.Role_id), 1, 'ADMIN'),
    'ADMIN crea un EJECUTIVO CAMPO',
  );
  await expect403(
    () => userService.createAndAssign(newPayload(ROLE_ADMIN_DTC.Role_id), 1, undefined),
    'actorRoleName undefined creando ADMIN_DTC (falla cerrado)',
  );
  await expectPass(
    () => userService.createAndAssign(newPayload(ROLE_ADMIN_DTC.Role_id), 1, '  admin_dtc  '),
    "actorRoleName '  admin_dtc  ' creando ADMIN_DTC (normalizeRole)",
  );
  await expect403(
    () => userService.updateUserEnterprise(10, 1, { roleId: ROLE_ADMIN_DTC.Role_id }, 'ADMIN'),
    'ADMIN cambia una relación a ADMIN_DTC',
  );
  await expectPass(
    () => userService.updateUserEnterprise(10, 1, { roleId: ROLE_ADMIN_DTC.Role_id }, 'ADMIN_DTC'),
    'ADMIN_DTC cambia una relación a ADMIN_DTC',
  );
  await expectPass(
    () => userService.updateUserEnterprise(10, 1, { roleId: ROLE_EJECUTIVO.Role_id }, 'ADMIN'),
    'ADMIN cambia una relación a EJECUTIVO CAMPO',
  );

  console.log(`\n${passed}/${passed + failed} pasaron\n`);
  if (failed > 0) process.exit(1);
})();
