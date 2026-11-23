// Pruebas de SEGURIDAD de todo /api/adm (sección 9 del contexto ADM).
//
// Qué cubre:
//   a) Control de acceso de TODAS las rutas del router (se recorren desde router.stack, no se
//      enumeran a mano: una ruta nueva sin control de rol rompe esta prueba).
//      - sin token, token inválido y token expirado -> 401;
//      - rutas solo DTC: ADMIN, GERENCIA, EJECUTIVO CAMPO y AUDITOR CAMPO -> 403;
//      - rutas que ve el cliente: EJECUTIVO CAMPO y AUDITOR CAMPO -> 403; ADMIN y GERENCIA pasan el
//        control de rol (el 500 de la base simulada es aceptable);
//      - las respuestas de error no filtran trazas, SQL ni el texto de un error de base.
//   b) Aislamiento por empresa en las rutas que ve el cliente (GET /contract, /billing-profile, /invoices).
//   c) Roles comparados sin distinguir mayúsculas ni espacios, y nunca por Role_id.
//   d) Barrido estático de src/**/adm*.js: sin secretos literales ni logs de datos sensibles.
//   e) Manejo de errores de los 7 controladores adm* (corrección P4b del hallazgo de P4): los 4xx
//      conservan mensaje y field; los 500 responden un mensaje fijo y registran un objeto seguro.
//
// Cómo, sin base ni servidor:
//   - Se usa el router REAL (src/routes/admRoutes.js) y el authMiddleware REAL dentro de una app
//     express de prueba. Las peticiones se inyectan en memoria con app.handle (no se abre ningún
//     puerto ni se arranca ningún servidor).
//   - Los tokens se firman con jsonwebtoken y un JWT_SECRET DE PRUEBA fijado aquí (nunca del .env).
//   - src/config/db se reemplaza en require.cache. Modo "throw": getPool() lanza
//     "DB no disponible en pruebas", así una ruta que llegue al controlador sin control de rol
//     responde 500 en vez de 403 y la prueba lo detecta. Modo "record": un pool falso que anota
//     los parámetros y devuelve listas vacías, para comprobar QUÉ empresa se consultó.
//
// Correr: node --test src/routes/__tests__/admSecurity.test.mjs
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const require = createRequire(import.meta.url);
const SRC = path.join(process.cwd(), 'src');

// ---------------------------------------------------------------------------
// Configuración de prueba (antes de cargar cualquier módulo de la app)
// ---------------------------------------------------------------------------

// Secreto SOLO para esta prueba. authMiddleware lo lee de process.env al verificar.
const TEST_SECRET = 'secreto-solo-para-pruebas-de-seguridad-adm';
process.env.JWT_SECRET = TEST_SECRET;
// Se usan los roles de cliente por defecto (ADMIN, GERENCIA), no los del entorno de quien corre la prueba.
delete process.env.ADM_CLIENT_VIEW_ROLES;

// Base de datos simulada. `dbMode` decide qué hace getPool().
const DB_ERROR_TEXT = 'DB no disponible en pruebas';
let dbMode = 'throw';
let dbLog = []; // en modo "record": [{ text, params }]
let dbCustomError = null; // en modo "custom": el error que lanza getPool()

// Pool falso del modo "record": cada request anota sus parámetros y la consulta, y devuelve vacío.
function recordingPool() {
  const makeRequest = () => {
    const params = {};
    return {
      input(name, _type, value) { params[name] = value; return this; },
      async query(text) { dbLog.push({ text, params }); return { recordset: [], rowsAffected: [0] }; },
    };
  };
  return { request: makeRequest, transaction: () => { throw new Error('sin transacciones en modo record'); } };
}

const dbId = require.resolve(path.join(SRC, 'config', 'db.js'));
require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  exports: {
    getPool: async () => {
      if (dbMode === 'throw') throw new Error(DB_ERROR_TEXT);
      if (dbMode === 'custom') throw dbCustomError;
      return recordingPool();
    },
    // `sql` real de mssql: solo define tipos (sql.Int, sql.VarChar(30)...). No conecta a nada.
    sql: require('mssql'),
  },
};

const express = require('express');
const jwt = require('jsonwebtoken');
const authMiddleware = require(path.join(SRC, 'middlewares', 'authMiddleware.js'));
const admRoutes = require(path.join(SRC, 'routes', 'admRoutes.js'));

// App de prueba montada igual que en src/app.js: app.use('/api/adm', authMiddleware, admRoutes).
const app = express();
app.use('/api/adm', authMiddleware, admRoutes);

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

// Inyecta una petición en la app SIN abrir un puerto: se arma un IncomingMessage y un
// ServerResponse reales de node:http y se captura lo que express escribe con res.end.
function inject({ method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(new net.Socket());
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    // No hay body-parser en esta app de prueba: el cuerpo se deja ya "parseado" como lo dejaría express.json().
    req.body = body ?? {};
    req.push(null); // el flujo de la petición termina (no hay más datos)

    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (chunk) => { if (chunk) chunks.push(Buffer.from(chunk)); return true; };
    res.end = (chunk, encoding) => {
      if (chunk && typeof chunk !== 'function') {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { /* no es JSON */ }
      resolve({ status: res.statusCode, text, json });
      return res;
    };
    // Si ninguna ruta respondió, express llama a este callback: es un error de la prueba.
    app.handle(req, res, (err) => reject(err ?? new Error(`Nadie respondió ${method} ${url}`)));
  });
}

// Firma un token como el de authService (mismo payload). `roleId` se deja configurable para
// probar que el rol NUNCA se decide por Role_id.
function tokenFor({ roleName, enterpriseId = 34, userId = 900, roleId = 5, expiresIn = '5m', secret = TEST_SECRET }) {
  return jwt.sign(
    { userId, email: 'prueba@ejemplo.com', username: 'prueba', enterpriseId, roleId, roleName },
    secret,
    { expiresIn },
  );
}
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// Ejecuta fn con console.error silenciado (los controladores registran los 500 de la base
// simulada; no interesa ensuciar la salida de las pruebas con eso).
async function quiet(fn) {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
}

// Todas las rutas del router, leídas de router.stack. Los parámetros :id se reemplazan por 1.
const ROUTES = admRoutes.stack
  .filter((layer) => layer.route)
  .flatMap((layer) => Object.keys(layer.route.methods).map((m) => ({
    method: m.toUpperCase(),
    path: layer.route.path,
    url: `/api/adm${layer.route.path.replace(/:[A-Za-z]+/g, '1')}`,
  })));

// Rutas que la spec deja ver al CLIENTE (sección 5 y 6). Todo lo demás debe ser solo DTC.
// Esta lista es la ÚNICA enumeración a mano: una ruta nueva que no esté aquí se trata como
// solo DTC y debe responder 403 a los roles de cliente.
const CLIENT_VISIBLE = new Set(['GET /contract', 'GET /billing-profile', 'GET /invoices']);
const key = (r) => `${r.method} ${r.path}`;
const DTC_ONLY_ROUTES = ROUTES.filter((r) => !CLIENT_VISIBLE.has(key(r)));
const CLIENT_ROUTES = ROUTES.filter((r) => CLIENT_VISIBLE.has(key(r)));

// Textos que nunca deben aparecer en una respuesta de error: trazas, SQL o el error de la base.
function assertNoLeak(res, context) {
  const forbidden = [
    { re: new RegExp(DB_ERROR_TEXT), what: 'el texto del error de la base' },
    { re: /\bat .+\(.+:\d+:\d+\)/, what: 'una traza (stack trace)' },
    { re: /node_modules|src\/(repositories|services|controllers)/, what: 'rutas de archivos del servidor' },
    { re: /\b(SELECT|INSERT|UPDATE|DELETE)\b.+\b(FROM|INTO|SET)\b/i, what: 'texto SQL' },
    { re: /RETSC_[A-Z_]+/, what: 'nombres de tablas' },
    { re: /mssql|tedious|ConnectionError|RequestError/i, what: 'detalles del driver de base de datos' },
  ];
  for (const f of forbidden) {
    assert.doesNotMatch(res.text, f.re, `${context}: la respuesta filtra ${f.what}: ${res.text.slice(0, 200)}`);
  }
}

beforeEach(() => { dbMode = 'throw'; dbLog = []; dbCustomError = null; });

// ---------------------------------------------------------------------------
// a) Control de acceso en TODAS las rutas
// ---------------------------------------------------------------------------
describe('a) Control de acceso en todas las rutas de /api/adm', () => {
  test('El router tiene rutas y las tres rutas de cliente existen', () => {
    assert.ok(ROUTES.length >= 17, `se esperaban al menos 17 rutas, hay ${ROUTES.length}`);
    for (const k of CLIENT_VISIBLE) assert.ok(ROUTES.some((r) => key(r) === k), `falta la ruta de cliente ${k}`);
  });

  test('Sin token, token inválido, token de otro secreto y token expirado -> 401 en todas las rutas', async () => {
    const otherSecret = tokenFor({ roleName: 'ADMIN_DTC', secret: 'otro-secreto' });
    const expired = jwt.sign({ userId: 1, enterpriseId: 34, roleName: 'ADMIN_DTC', exp: Math.floor(Date.now() / 1000) - 60 }, TEST_SECRET);
    for (const r of ROUTES) {
      const ctx = `${r.method} ${r.url}`;
      const none = await inject({ method: r.method, url: r.url });
      assert.equal(none.status, 401, `${ctx} sin token`);
      assertNoLeak(none, `${ctx} sin token`);

      const empty = await inject({ method: r.method, url: r.url, headers: { Authorization: 'Bearer ' } });
      assert.equal(empty.status, 401, `${ctx} "Bearer " vacío`);

      const garbage = await inject({ method: r.method, url: r.url, headers: bearer('esto.no.es-un-jwt') });
      assert.equal(garbage.status, 401, `${ctx} token basura`);
      assertNoLeak(garbage, `${ctx} token basura`);

      const forged = await inject({ method: r.method, url: r.url, headers: bearer(otherSecret) });
      assert.equal(forged.status, 401, `${ctx} token firmado con otro secreto`);

      const exp = await inject({ method: r.method, url: r.url, headers: bearer(expired) });
      assert.equal(exp.status, 401, `${ctx} token expirado`);
      assert.equal(exp.json?.code, 'TOKEN_EXPIRED', `${ctx} token expirado: falta code TOKEN_EXPIRED`);
    }
  });

  test('Rutas solo DTC: ADMIN, GERENCIA, EJECUTIVO CAMPO y AUDITOR CAMPO -> 403 (sin llegar a la base)', async () => {
    assert.ok(DTC_ONLY_ROUTES.length >= 14);
    for (const roleName of ['ADMIN', 'GERENCIA', 'EJECUTIVO CAMPO', 'AUDITOR CAMPO']) {
      const headers = bearer(tokenFor({ roleName }));
      for (const r of DTC_ONLY_ROUTES) {
        const res = await quiet(() => inject({ method: r.method, url: `${r.url}?enterpriseId=34`, headers, body: { enterpriseId: 34 } }));
        // Un 500 aquí significaría que la petición llegó al controlador (y a la base) sin control de rol.
        assert.equal(res.status, 403, `${roleName} en ${r.method} ${r.path} respondió ${res.status}`);
        assert.equal(res.json?.success, false);
        assertNoLeak(res, `${roleName} en ${r.method} ${r.path}`);
      }
    }
  });

  test('Rutas de cliente: EJECUTIVO CAMPO y AUDITOR CAMPO -> 403; ADMIN y GERENCIA pasan el control de rol', async () => {
    for (const r of CLIENT_ROUTES) {
      for (const roleName of ['EJECUTIVO CAMPO', 'AUDITOR CAMPO']) {
        const res = await inject({ method: r.method, url: r.url, headers: bearer(tokenFor({ roleName })) });
        assert.equal(res.status, 403, `${roleName} en ${r.method} ${r.path}`);
        assertNoLeak(res, `${roleName} en ${r.method} ${r.path}`);
      }
      for (const roleName of ['ADMIN', 'GERENCIA']) {
        const res = await quiet(() => inject({ method: r.method, url: r.url, headers: bearer(tokenFor({ roleName })) }));
        // Pasan el rol y llegan a la base simulada, que falla: 500 es lo esperado aquí.
        assert.notEqual(res.status, 403, `${roleName} en ${r.method} ${r.path} no debería recibir 403`);
        assert.equal(res.status, 500, `${roleName} en ${r.method} ${r.path}: se esperaba el 500 de la base simulada`);
      }
    }
  });

  // Regresión del HALLAZGO de P4 (corregido en P4b): antes, los handleError de los 7 controladores
  // adm* respondían `message: err.message` también en los 500, y el texto del error del driver SQL
  // (servidor, tablas, usuario...) llegaba al navegador. Ahora un 500 responde un mensaje fijo.
  test('Corregido (era HALLAZGO de P4): un 500 responde "Error interno del servidor", sin el error de la base', async () => {
    const leaks = [];
    const check = async (r, roleName, url) => {
      const res = await quiet(() => inject({ method: r.method, url, headers: bearer(tokenFor({ roleName, enterpriseId: 34 })), body: {} }));
      if (res.status === 500) {
        if (res.text.includes(DB_ERROR_TEXT)) leaks.push(`${roleName} ${r.method} ${r.path} -> ${res.text}`);
        assert.deepEqual(res.json, { success: false, message: 'Error interno del servidor' }, `${roleName} ${r.method} ${r.path}`);
      }
    };
    // Cliente (ADMIN) en sus rutas, y DTC en todas las de lectura con empresa indicada.
    for (const r of CLIENT_ROUTES) await check(r, 'ADMIN', r.url);
    for (const r of ROUTES.filter((x) => x.method === 'GET')) await check(r, 'ADMIN_DTC', `${r.url}?enterpriseId=34`);
    assert.deepEqual(leaks, [], `Respuestas 500 que filtran el error de la base:\n  ${leaks.join('\n  ')}`);
  });
});

// ---------------------------------------------------------------------------
// b) Aislamiento por empresa en las rutas que ve el cliente
// ---------------------------------------------------------------------------
describe('b) Aislamiento por empresa (GET /contract, /billing-profile, /invoices)', () => {
  const adminOf34 = bearer(tokenFor({ roleName: 'ADMIN', enterpriseId: 34 }));
  const dtc = bearer(tokenFor({ roleName: 'ADMIN_DTC', enterpriseId: 2 }));
  const CLIENT_PATHS = ['/contract', '/billing-profile', '/invoices'];

  test('ADMIN de la empresa 34 pidiendo ?enterpriseId=33 -> 404 (nunca 403) y sin consultar la base', async () => {
    dbMode = 'record';
    for (const p of CLIENT_PATHS) {
      const res = await inject({ url: `/api/adm${p}?enterpriseId=33`, headers: adminOf34 });
      assert.equal(res.status, 404, `${p}`);
      assertNoLeak(res, p);
    }
    assert.equal(dbLog.length, 0, 'no debe consultarse la base para otra empresa');
  });

  test('Sin parámetro: se consulta la empresa del TOKEN (34)', async () => {
    dbMode = 'record';
    for (const p of CLIENT_PATHS) {
      dbLog = [];
      const res = await inject({ url: `/api/adm${p}`, headers: adminOf34 });
      assert.equal(res.status, 200, `${p}`);
      assert.ok(dbLog.length > 0, `${p} debió consultar la base`);
      for (const q of dbLog) assert.equal(q.params.enterpriseId, 34, `${p} consultó la empresa ${q.params.enterpriseId}`);
    }
  });

  test('Pedir su propia empresa explícitamente está permitido (?enterpriseId=34)', async () => {
    dbMode = 'record';
    const res = await inject({ url: '/api/adm/invoices?enterpriseId=34', headers: adminOf34 });
    assert.equal(res.status, 200);
    assert.ok(dbLog.every((q) => q.params.enterpriseId === 34));
  });

  test('?enterpriseId= repetido, con basura o como objeto -> 404 o 422, nunca datos de otra empresa', async () => {
    dbMode = 'record';
    const attempts = [
      'enterpriseId=34&enterpriseId=33', // repetido: llega como arreglo
      'enterpriseId=33&enterpriseId=34',
      'enterpriseId=33abc',
      'enterpriseId=33;34',
      'enterpriseId=-33',
      'enterpriseId=33.5',
      'enterpriseId[$ne]=34', // objeto (intento tipo NoSQL)
      'enterpriseId=%2033',   // " 33" con espacio: se interpreta como 33 -> otra empresa
      'enterpriseId=0x21',    // hexadecimal de 33
    ];
    for (const p of CLIENT_PATHS) {
      for (const qs of attempts) {
        dbLog = [];
        const res = await inject({ url: `/api/adm${p}?${qs}`, headers: adminOf34 });
        assert.ok([404, 422].includes(res.status), `${p}?${qs} respondió ${res.status}`);
        assert.equal(dbLog.length, 0, `${p}?${qs} no debe consultar la base`);
        assertNoLeak(res, `${p}?${qs}`);
      }
    }
  });

  test('ADMIN_DTC sin ?enterpriseId= -> 422 con field enterpriseId', async () => {
    dbMode = 'record';
    for (const p of CLIENT_PATHS) {
      const res = await inject({ url: `/api/adm${p}`, headers: dtc });
      assert.equal(res.status, 422, p);
      assert.equal(res.json?.field, 'enterpriseId', p);
    }
    assert.equal(dbLog.length, 0);
  });

  test('ADMIN_DTC con ?enterpriseId=33 consulta la 33 (el DTC sí elige empresa)', async () => {
    dbMode = 'record';
    const res = await inject({ url: '/api/adm/contract?enterpriseId=33', headers: dtc });
    assert.equal(res.status, 200);
    assert.ok(dbLog.length > 0 && dbLog.every((q) => q.params.enterpriseId === 33));
  });
});

// ---------------------------------------------------------------------------
// c) Comparación de roles
// ---------------------------------------------------------------------------
describe('c) Roles: sin distinguir mayúsculas ni espacios, y nunca por Role_id', () => {
  test("' admin_dtc ' y 'Admin_Dtc' siguen siendo DTC en una ruta solo DTC", async () => {
    dbMode = 'record';
    for (const roleName of [' admin_dtc ', 'Admin_Dtc', 'ADMIN_DTC']) {
      const res = await inject({ url: '/api/adm/contracts?enterpriseId=33', headers: bearer(tokenFor({ roleName })) });
      assert.equal(res.status, 200, `rol ${JSON.stringify(roleName)}`);
    }
  });

  test("' admin ' y 'gerencia' en minúsculas se tratan como roles de cliente (403 en DTC, pasan en cliente)", async () => {
    dbMode = 'record';
    for (const roleName of [' admin ', 'gerencia']) {
      const headers = bearer(tokenFor({ roleName, enterpriseId: 34 }));
      assert.equal((await inject({ url: '/api/adm/aging', headers })).status, 403, roleName);
      assert.equal((await inject({ url: '/api/adm/invoices', headers })).status, 200, roleName);
    }
  });

  test('El Role_id del token no da ni quita permisos: solo cuenta roleName', async () => {
    dbMode = 'record';
    // roleName ADMIN con cualquier roleId (incluido el que ADMIN_DTC tiene en prod o en QA) -> 403 en DTC.
    for (const roleId of [1, 2, 4, 7, 8, 9]) {
      const res = await inject({ url: '/api/adm/aging', headers: bearer(tokenFor({ roleName: 'ADMIN', roleId })) });
      assert.equal(res.status, 403, `ADMIN con roleId=${roleId}`);
    }
    // roleName ADMIN_DTC con un roleId absurdo -> sigue siendo DTC.
    const ok = await inject({ url: '/api/adm/aging', headers: bearer(tokenFor({ roleName: 'ADMIN_DTC', roleId: 99999 })) });
    assert.equal(ok.status, 200);
    // Un token sin roleName (solo roleId) -> 403.
    const noName = jwt.sign({ userId: 1, enterpriseId: 34, roleId: 1 }, TEST_SECRET, { expiresIn: '5m' });
    assert.equal((await inject({ url: '/api/adm/aging', headers: bearer(noName) })).status, 403);
  });

  test('Ningún archivo adm* decide permisos con roleId / Role_id', () => {
    for (const file of admSourceFiles()) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      assert.doesNotMatch(code, /\broleId\b|\bRole_id\b/, `${path.relative(process.cwd(), file)} usa roleId/Role_id`);
    }
  });
});

// ---------------------------------------------------------------------------
// d) Barrido estático de secretos y logs sensibles
// ---------------------------------------------------------------------------

// Todos los archivos src/**/adm*.js (no incluye las pruebas, que son .mjs).
function admSourceFiles() {
  return fs.readdirSync(SRC, { recursive: true })
    .map((rel) => path.join(SRC, rel))
    .filter((f) => /^adm.*\.js$/.test(path.basename(f)) && fs.statSync(f).isFile());
}

// Quita comentarios // y /* */ para no marcar como hallazgo un texto que solo se menciona en un
// comentario. (Sencillo: suficiente para este código; no interpreta strings con "//" dentro.)
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('d) Barrido estático de src/**/adm*.js', () => {
  const files = admSourceFiles();

  test('Se encontraron los archivos adm* (controladores, servicios, repositorios, utils y rutas)', () => {
    assert.ok(files.length >= 20, `solo se encontraron ${files.length} archivos adm*`);
    for (const dir of ['controllers', 'services', 'repositories', 'utils', 'routes']) {
      assert.ok(files.some((f) => f.includes(`${path.sep}${dir}${path.sep}`)), `no hay archivos adm* en ${dir}`);
    }
  });

  test('Sin contraseñas, tokens ni cadenas de conexión literales', () => {
    const patterns = [
      { re: /Server\s*=/i, what: 'cadena de conexión (Server=)' },
      { re: /mssql:\/\//i, what: 'URL mssql://' },
      { re: /Bearer\s+eyJ/, what: 'token JWT literal' },
      { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: 'token JWT literal' },
      { re: /password\s*[:=]\s*['"`][^'"`]+['"`]/i, what: 'contraseña literal' },
      { re: /pwd\s*=/i, what: 'contraseña en cadena de conexión' },
      { re: /AccountKey\s*=/i, what: 'llave de Azure Storage' },
      { re: /DefaultEndpointsProtocol=/i, what: 'cadena de conexión de Azure Storage' },
      { re: /SharedAccessSignature|[?&]sig=[A-Za-z0-9%]/i, what: 'firma SAS' },
      { re: /[A-Za-z0-9+/]{80,}={1,2}/, what: 'llave en base64 (estilo Azure)' },
      { re: /\b[0-9a-f]{32}\b/i, what: 'llave hexadecimal de 32 caracteres (estilo Azure Cognitive)' },
      { re: /JWT_SECRET\s*=\s*['"`]/, what: 'JWT_SECRET literal' },
    ];
    const hits = [];
    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      for (const p of patterns) {
        if (p.re.test(code)) hits.push(`${path.relative(process.cwd(), file)}: ${p.what}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  test('Ningún console.* registra req.body, datos fiscales, correos de facturación ni tokens', () => {
    const sensitive = /req\.body|req\.headers|authorization|Billing_email|billingEmail|Tax_id|taxId|Legal_name|legalName|Billing_address|token/i;
    const hits = [];
    for (const file of files) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      // Cada llamada console.xxx( ... ) hasta el cierre de la línea (los logs del módulo son de una línea).
      for (const m of code.matchAll(/console\.(log|info|warn|error|debug)\(([^\n]*)/g)) {
        if (sensitive.test(m[2])) hits.push(`${path.relative(process.cwd(), file)}: ${m[0].trim()}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});

// ---------------------------------------------------------------------------
// e) Manejo de errores de los 7 controladores adm* (corrección P4b)
// ---------------------------------------------------------------------------
// Una ruta de LECTURA por controlador. Todas llegan a getPool() en su primer paso, así que el
// error que lance la base simulada (modo "custom") sube tal cual hasta el handleError del controlador.
const ONE_ROUTE_PER_CONTROLLER = [
  { controller: 'admContractController', tag: '[adm/contract]', url: '/api/adm/contract', role: 'ADMIN' },
  { controller: 'admBillingProfileController', tag: '[adm/billing-profile]', url: '/api/adm/billing-profile', role: 'ADMIN' },
  { controller: 'admInvoiceController', tag: '[adm/invoice]', url: '/api/adm/invoices', role: 'ADMIN' },
  { controller: 'admPaymentController', tag: '[adm/payment]', url: '/api/adm/invoices/1/payments', role: 'ADMIN_DTC' },
  { controller: 'admReceivablesController', tag: '[adm/receivables]', url: '/api/adm/aging', role: 'ADMIN_DTC' },
  { controller: 'admNoteController', tag: '[adm/note]', url: '/api/adm/invoices/1/notes', role: 'ADMIN_DTC' },
  { controller: 'admAuditController', tag: '[adm/audit]', url: '/api/adm/audit', role: 'ADMIN_DTC' },
];

// Hace la petición con la base lanzando `error` y devuelve la respuesta y lo registrado en console.error.
async function requestWithDbError(route, error) {
  dbMode = 'custom';
  dbCustomError = error;
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const res = await inject({ url: route.url, headers: bearer(tokenFor({ roleName: route.role, enterpriseId: 34 })) });
    return { res, logged };
  } finally {
    console.error = original;
  }
}

// Error SQL simulado con el texto que NUNCA debe salir del servidor.
const SQL_SECRET_TEXT = "Login failed for user 'sa' en sql-rscope-prod.database.windows.net";
const sqlLoginError = () => Object.assign(new Error(SQL_SECRET_TEXT), { name: 'ConnectionError', number: 18456 });

describe('e) handleError de los 7 controladores adm*', () => {
  test('El recorrido cubre los 7 controladores adm*', () => {
    const files = fs.readdirSync(path.join(SRC, 'controllers')).filter((f) => /^adm.*Controller\.js$/.test(f));
    assert.deepEqual(files.map((f) => f.replace('.js', '')).sort(), ONE_ROUTE_PER_CONTROLLER.map((r) => r.controller).sort());
  });

  test('(1) un 422 con payload { field } conserva su mensaje y su field', async () => {
    for (const route of ONE_ROUTE_PER_CONTROLLER) {
      const err = Object.assign(new Error('La moneda debe ser CRC o USD.'), { statusCode: 422, payload: { field: 'currency' } });
      const { res, logged } = await requestWithDbError(route, err);
      assert.equal(res.status, 422, route.controller);
      assert.deepEqual(res.json, { success: false, message: 'La moneda debe ser CRC o USD.', field: 'currency' }, route.controller);
      assert.equal(logged.length, 0, `${route.controller}: un 422 no se registra como error`);
    }
  });

  test('(2) un 404 conserva su mensaje', async () => {
    for (const route of ONE_ROUTE_PER_CONTROLLER) {
      const err = Object.assign(new Error('Factura no encontrada.'), { statusCode: 404 });
      const { res } = await requestWithDbError(route, err);
      assert.equal(res.status, 404, route.controller);
      assert.deepEqual(res.json, { success: false, message: 'Factura no encontrada.' }, route.controller);
    }
  });

  test('(3) un error SQL (number 18456) responde 500 con mensaje fijo, sin el texto del driver', async () => {
    for (const route of ONE_ROUTE_PER_CONTROLLER) {
      const { res } = await requestWithDbError(route, sqlLoginError());
      assert.equal(res.status, 500, route.controller);
      assert.deepEqual(res.json, { success: false, message: 'Error interno del servidor' }, route.controller);
      assert.doesNotMatch(res.text, /Login failed|sql-rscope-prod|database\.windows\.net|'sa'/, route.controller);
    }
  });

  test('(4) para ese error SQL, console.error registra un objeto seguro SIN el mensaje del driver', async () => {
    for (const route of ONE_ROUTE_PER_CONTROLLER) {
      const { logged } = await requestWithDbError(route, sqlLoginError());
      assert.equal(logged.length, 1, `${route.controller}: un solo registro`);
      assert.equal(logged[0].length, 1, `${route.controller}: se registra UN objeto`);
      const entry = logged[0][0];
      assert.deepEqual(entry, { tag: route.tag, name: 'ConnectionError', code: 18456 }, route.controller);
      // Nada del texto del driver ni una traza en lo registrado.
      const text = JSON.stringify(logged);
      assert.doesNotMatch(text, /Login failed|sql-rscope-prod|database\.windows\.net/, route.controller);
      assert.ok(!(entry instanceof Error), `${route.controller}: no debe registrar el objeto err completo`);
    }
  });

  test('(4b) un error con originalError (estilo mssql) también se trata como SQL: no registra su mensaje', async () => {
    const err = Object.assign(new Error(SQL_SECRET_TEXT), { name: 'RequestError', code: 'EREQUEST', originalError: { info: {} } });
    const { res, logged } = await requestWithDbError(ONE_ROUTE_PER_CONTROLLER[0], err);
    assert.equal(res.status, 500);
    assert.deepEqual(logged[0][0], { tag: '[adm/contract]', name: 'RequestError', code: 'EREQUEST' });
  });

  test('(5) un error de programación (TypeError) registra su mensaje, pero la respuesta sigue siendo fija', async () => {
    for (const route of ONE_ROUTE_PER_CONTROLLER) {
      const { res, logged } = await requestWithDbError(route, new TypeError('row.Currency.trim is not a function'));
      assert.equal(res.status, 500, route.controller);
      assert.deepEqual(res.json, { success: false, message: 'Error interno del servidor' }, route.controller);
      assert.deepEqual(logged[0][0], {
        tag: route.tag, name: 'TypeError', code: null, message: 'row.Currency.trim is not a function',
      }, route.controller);
      // El mensaje se registra, pero no la traza (stack).
      assert.doesNotMatch(JSON.stringify(logged), /\bat .+:\d+:\d+/, route.controller);
    }
  });

  test('Un 500 con payload no lo devuelve (el payload solo viaja en errores 4xx)', async () => {
    const err = Object.assign(new Error('fallo interno'), { statusCode: 500, payload: { field: 'secreto', detalle: 'interno' } });
    const { res } = await quiet(() => requestWithDbError(ONE_ROUTE_PER_CONTROLLER[0], err));
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { success: false, message: 'Error interno del servidor' });
  });
});
