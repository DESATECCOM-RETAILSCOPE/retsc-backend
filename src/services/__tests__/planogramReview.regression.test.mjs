// Ciclo 5 · B4/B5 (Fases 8.7, 8.8, 9) — revisión, aprobación, reporte de precisión y mapeo de
// códigos de cadena. Sin BD ni Azure (repos y blob simulados en memoria).
//
// Correr: node src/services/__tests__/planogramReview.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC  = (p) => require.resolve(path.join(process.cwd(), 'src', p));
const stub = (abs, exports) => { require.cache[abs] = { id: abs, filename: abs, loaded: true, exports }; };
const fresh = (p) => { delete require.cache[SRC(p)]; return require(SRC(p)); };

const CATALOGO = [
  { SKU_ID: 10, EAN: '7501000000010', Product_dsc: 'DEO A' },
  { SKU_ID: 20, EAN: '7501000000027', Product_dsc: 'DEO B' },
  { SKU_ID: 30, EAN: '0750100000034', Product_dsc: 'DEO C' },
];
stub(SRC('repositories/skuRepo.js'), {
  findSkusByEans: async (vars) => CATALOGO.filter((s) => vars.includes(s.EAN)),
  findSkusByIds: async (ids) => CATALOGO.filter((s) => ids.map(Number).includes(s.SKU_ID)),
  searchSkus: async ({ eanVariants = [], digits, words = [] }) => CATALOGO.filter((s) =>
    eanVariants.includes(s.EAN) || (digits && s.EAN.includes(digits)) || (words.length && words.every((w) => s.Product_dsc.includes(w.toUpperCase())))),
});

const pos = (pos_id, col, extra = {}) => ({ pos_id, shelfcolumn_id: col, sku_id: null, match: 'SIN_MATCH', estado: 'REVISAR', facings: 1, ...extra });
// Lectura del sistema: mueble 1 con 2 filas.
function propuestaBase() {
  return {
    formato: 'LISTA_BANDEJAS',
    muebles: [{ shelfunit_id: 1, niveles: [
      { shelflevel_id: 1, bandeja: 3, orden_fuente: 'IA', posiciones: [
        pos('pos-1', 1, { sku_id: 10, match: 'EAN_EXACTO', estado: 'OK', upc: '7501000000010', texto_leido: 'DEO A', bbox: { x: 0.1 } }),
        pos('pos-2', 2, { sku_id: 20, match: 'EAN_EXACTO', estado: 'OK', upc: '7501000000027', texto_leido: 'DEO B' }),
        pos('pos-3', 3, { upc: '999', texto_leido: 'NO ESTA' }),
      ] },
      { shelflevel_id: 2, bandeja: 1, orden_fuente: 'IA', posiciones: [
        pos('pos-4', 1, { sku_id: 30, match: 'EAN_EXACTO', estado: 'OK', upc: '750100000034' }),
      ] },
    ] }],
    resumen: {},
    advertencias: [],
  };
}
const catalogoMap = new Map(CATALOGO.map((s) => [s.SKU_ID, s]));

// ── Lógica pura ──────────────────────────────────────────────────────────────
test('asignarPosIds: numera solo las que no tienen y sigue desde el máximo', () => {
  const r = fresh('services/planogramReviewService.js');
  const p = { muebles: [{ shelfunit_id: 1, niveles: [{ shelflevel_id: 1, posiciones: [{ pos_id: 'pos-7' }, {}, {}] }] }] };
  r.asignarPosIds(p);
  assert.deepEqual(p.muebles[0].niveles[0].posiciones.map((x) => x.pos_id), ['pos-7', 'pos-8', 'pos-9']);
});

test('normalizarEdicion: payload liviano — conserva datos por pos_id, renumera columnas y completa el SKU', () => {
  const r = fresh('services/planogramReviewService.js');
  const original = propuestaBase();
  const muebles = [{ shelfunit_id: 1, niveles: [
    { shelflevel_id: 1, posiciones: [{ pos_id: 'pos-2', sku_id: 20, facings: 1 }, { pos_id: 'pos-1', sku_id: 10, facings: 2 }, { pos_id: 'pos-3', sku_id: 30, facings: 1 }] },
    { shelflevel_id: 2, posiciones: [{ pos_id: 'pos-4', sku_id: 30, facings: 1 }, { sku_id: null, facings: null }] },
  ] }];
  const out = r.normalizarEdicion(muebles, { original, catalogo: catalogoMap });
  const f1 = out[0].niveles[0];
  assert.equal(f1.bandeja, 3, 'los datos de la fila se toman de la propuesta anterior');
  assert.deepEqual(f1.posiciones.map((x) => [x.pos_id, x.shelfcolumn_id]), [['pos-2', 1], ['pos-1', 2], ['pos-3', 3]]);
  assert.equal(f1.posiciones[1].texto_leido, 'DEO A', 'conserva lo leído');
  assert.deepEqual(f1.posiciones[1].bbox, { x: 0.1 });
  assert.equal(f1.posiciones[1].facings, 2);
  const asignado = f1.posiciones[2];
  assert.equal(asignado.sku_dsc, 'DEO C');
  assert.equal(asignado.match, 'MANUAL');
  assert.equal(asignado.match_detalle, 'ASIGNADO_EN_REVISION');
  assert.equal(asignado.estado, 'OK');
  const nueva = out[0].niveles[1].posiciones[1];
  assert.equal(nueva.pos_id, 'pos-5', 'la nueva recibe id');
  assert.equal(nueva.estado, 'REVISAR');
});

test('normalizarEdicion: SKU inexistente, frentes o fila inválidos → 400', () => {
  const r = fresh('services/planogramReviewService.js');
  const base = (p, level = 1) => [{ shelfunit_id: 1, niveles: [{ shelflevel_id: level, posiciones: [p] }] }];
  assert.throws(() => r.normalizarEdicion(base({ pos_id: 'pos-1', sku_id: 999 }), { catalogo: catalogoMap }), (e) => e.errorCode === 'ERR_SKU_NO_EXISTE');
  assert.throws(() => r.normalizarEdicion(base({ pos_id: 'pos-1', facings: 0 }), { catalogo: catalogoMap }), (e) => e.errorCode === 'ERR_REVISION_INVALIDA');
  assert.throws(() => r.normalizarEdicion(base({ pos_id: 'pos-1' }, 0), { catalogo: catalogoMap }), (e) => e.errorCode === 'ERR_REVISION_INVALIDA');
  assert.throws(() => r.normalizarEdicion([], {}), (e) => e.errorCode === 'ERR_REVISION_INVALIDA');
});

test('filasParaAprobar: bloquea si queda alguna posición sin SKU (regla B4) y lista cuáles', () => {
  const r = fresh('services/planogramReviewService.js');
  assert.throws(() => r.filasParaAprobar(propuestaBase()), (e) => e.errorCode === 'ERR_POSICIONES_SIN_SKU' && e.pendientes.length === 1 && e.pendientes[0].codigo === '999');
  const ok = propuestaBase();
  ok.muebles[0].niveles[0].posiciones[2].sku_id = 30;
  const filas = r.filasParaAprobar(ok);
  assert.equal(filas.length, 4);
  assert.deepEqual(filas[0], { Shelfunit_id: 1, Shelflevel_id: 1, Shelfcolumn_id: 1, Facings: 1, Height: null, Width: null, Depth: null, sku_id: 10 });
});

test('calcularPrecision: sin cambios → 100 % sin corregir', () => {
  const r = fresh('services/planogramReviewService.js');
  const m = r.calcularPrecision(propuestaBase(), propuestaBase());
  assert.equal(m.posiciones_leidas, 4);
  assert.equal(m.pct_sin_corregir, 100);
  assert.equal(m.pct_ean_exacto, 75);
  assert.equal(m.pct_sin_identificar, 25);
  assert.equal(m.sku_propuesto_sin_codigo, 0);
});

test('calcularPrecision: SKU asignado, un producto movido y uno agregado al inicio (no penaliza a los demás)', () => {
  const r = fresh('services/planogramReviewService.js');
  const original = propuestaBase();
  const final = r.normalizarEdicion([{ shelfunit_id: 1, niveles: [
    // pos-3 recibe SKU y pasa al inicio; se agrega una nueva al inicio de todo.
    { shelflevel_id: 1, posiciones: [{ sku_id: 20 }, { pos_id: 'pos-3', sku_id: 30, facings: 1 }, { pos_id: 'pos-1', sku_id: 10, facings: 1 }, { pos_id: 'pos-2', sku_id: 20, facings: 1 }] },
    { shelflevel_id: 2, posiciones: [{ pos_id: 'pos-4', sku_id: 30, facings: 1 }] },
  ] }], { original, catalogo: catalogoMap });
  const m = r.calcularPrecision(original, { muebles: final });
  assert.equal(m.agregadas, 1);
  assert.equal(m.correcciones.sku_cambiado, 1);
  assert.equal(m.correcciones.orden, 1, 'solo pos-3 se movió; pos-1 y pos-2 conservan su orden relativo');
  assert.equal(m.sin_corregir, 3);
  assert.equal(m.pct_sin_corregir, 75);
});

test('calcularPrecision: borrar y mover a otra fila cuentan como corrección', () => {
  const r = fresh('services/planogramReviewService.js');
  const original = propuestaBase();
  const final = r.normalizarEdicion([{ shelfunit_id: 1, niveles: [
    { shelflevel_id: 1, posiciones: [{ pos_id: 'pos-1', sku_id: 10, facings: 1 }] },
    { shelflevel_id: 2, posiciones: [{ pos_id: 'pos-4', sku_id: 30, facings: 1 }, { pos_id: 'pos-2', sku_id: 20, facings: 1 }] },
  ] }], { original, catalogo: catalogoMap });
  const m = r.calcularPrecision(original, { muebles: final });
  assert.equal(m.correcciones.eliminadas, 1);
  assert.equal(m.correcciones.otra_fila, 1);
  assert.equal(m.sin_corregir, 2);
});

// ── Mapeo de códigos de cadena ───────────────────────────────────────────────
test('parsearCsv: encabezado opcional, separadores , ; tab, errores por línea', () => {
  const cm = fresh('services/planogramCodeMapService.js');
  const r = cm.parsearCsv('codigo;ean\n460940;7501000000010\n468090,7501000000027\n439010\t0750100000034\nabc,123\n478325,12\n460940,7501000000027\n');
  assert.equal(Object.keys(r.codigos).length, 3);
  assert.equal(r.codigos['460940'], '7501000000027', 'repetido: gana el último');
  assert.equal(r.errores.length, 3);
  assert.ok(r.errores.some((e) => /numérico/.test(e.motivo)) && r.errores.some((e) => /entre 7 y 14/.test(e.motivo)) && r.errores.some((e) => /repetido/.test(e.motivo)));
});

test('guardarMapeo / leerMapeo / resumen: un archivo por empresa + cadena en el blob', async () => {
  const store = new Map();
  stub(SRC('services/blobStorageService.js'), {
    ensureContainerExists: async () => {},
    uploadToContainer: async ({ blobPath, buffer }) => { store.set(blobPath, buffer); return { url: 'x', mode: 'mock' }; },
    downloadFromContainer: async ({ blobPath }) => { if (!store.has(blobPath)) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return store.get(blobPath); },
  });
  const cm = fresh('services/planogramCodeMapService.js');
  assert.deepEqual(await cm.resumenMapeo(2, 3), { existe: false, total: 0 });
  const r = await cm.guardarMapeo({ enterpriseId: 2, chainId: 3, buffer: Buffer.from('460940,7501000000010\n468090,7501000000027'), nombreArchivo: 'm.csv', userId: 44 });
  assert.equal(r.total, 2);
  assert.ok(store.has('_codigos-cadena/2-3.json'));
  assert.equal((await cm.leerMapeo(2, 3)).codigos['468090'], '7501000000027');
  assert.equal((await cm.resumenMapeo(2, 3)).total, 2);
  await assert.rejects(cm.guardarMapeo({ enterpriseId: 2, chainId: 3, buffer: Buffer.from('codigo,ean\nx,y') }), (e) => e.errorCode === 'ERR_MAPEO_VACIO');
});

const FIX_B = process.env.PLANOGRAM_PDF_FIXTURE_SP || path.join(process.cwd(), '..', 'desodorantes 6x119 prueba.pdf');
test('SPACE_PLANNING real + mapeo: los códigos mapeados llegan al SKU (EAN_EXACTO / MAPEO_CADENA)', { skip: !fs.existsSync(FIX_B) && `no está ${FIX_B}` }, async () => {
  const sp = fresh('services/planogramSpacePlanningService.js');
  // 460940 → EAN del catálogo; 468090 → EAN que no está; el resto sin mapeo.
  const p = await sp.construirPropuestaSpacePlanning({ buffer: fs.readFileSync(FIX_B), mapeoCodigos: { 460940: '7501000000010', 468090: '7509999999999' } });
  const todas = p.muebles.flatMap((m) => m.niveles.flatMap((n) => n.posiciones));
  const a = todas.find((x) => x.codigo_cadena === '460940');
  const b = todas.find((x) => x.codigo_cadena === '468090');
  assert.equal(a.sku_id, 10);
  assert.equal(a.match_detalle, 'MAPEO_CADENA');
  assert.equal(a.estado, 'OK');
  assert.equal(b.sku_id, null);
  assert.equal(b.match_detalle, 'NO_ESTA_EN_CATALOGO');
  assert.equal(p.resumen.con_sku, 1);
  assert.ok(p.advertencias.some((x) => /2\/292 posiciones con EAN, 1 con SKU/.test(x)));
});

// ── Servicio: guardar revisión, aprobar, buscar ──────────────────────────────
function loadSvc({ status = 'BORRADOR', doc = { estado: 'LISTO', formato: 'LISTA_BANDEJAS', propuesta: propuestaBase() } } = {}) {
  const store = new Map([['e/c/t/k/x.pdf.propuesta.json', Buffer.from(JSON.stringify(doc))]]);
  const calls = { aprobar: [] };
  const fila = { Planogram_seq: 9, Status: status, URL_picture: 'e/c/t/k/x.pdf', Supermarketchain_id: 3 };
  stub(SRC('repositories/planogramRepo.js'), {
    findBySeq: async () => fila,
    findChainById: async (id) => (id === 3 ? { Supermarketchain_id: 3 } : null),
    aprobarPlanograma: async (args) => { calls.aprobar.push(args); fila.Status = 'ACTIVO'; return { filas: args.filas.length, inactivados: [{ Planogram_seq: 4, Down_date: '2026-10-31' }] }; },
  });
  for (const r of ['retailerRepo', 'enterpriseRepo', 'enterpriseCategoryRepo']) stub(SRC(`repositories/${r}.js`), {});
  stub(SRC('services/blobStorageService.js'), {
    ensureContainerExists: async () => {},
    uploadToContainer: async ({ blobPath, buffer }) => { store.set(blobPath, buffer); return { url: 'x', mode: 'mock' }; },
    downloadFromContainer: async ({ blobPath }) => { if (!store.has(blobPath)) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return store.get(blobPath); },
  });
  fresh('services/planogramCodeMapService.js');
  return { svc: fresh('services/planogramService.js'), store, calls };
}
const slim = (p) => ({ muebles: p.muebles.map((m) => ({ shelfunit_id: m.shelfunit_id, niveles: m.niveles.map((n) => ({ shelflevel_id: n.shelflevel_id, posiciones: n.posiciones.map(({ pos_id, sku_id, facings }) => ({ pos_id, sku_id, facings })) })) })) });

test('guardarRevision: guarda, conserva la lectura original y devuelve la precisión', async () => {
  const { svc, store } = loadSvc();
  const body = slim(propuestaBase());
  body.muebles[0].niveles[0].posiciones[2].sku_id = 30;          // asigna el SKU que faltaba
  const r = await svc.guardarRevision(9, 2, 44, body);
  assert.equal(r.propuesta.resumen.sin_sku, 0);
  assert.equal(r.precision.correcciones.sku_cambiado, 1);
  const guardado = JSON.parse(store.get('e/c/t/k/x.pdf.propuesta.json'));
  assert.equal(guardado.propuesta_original.muebles[0].niveles[0].posiciones[2].sku_id, null, 'la original no se toca');
  assert.equal(guardado.revision.usuario, 44);
  // Segunda edición: la original sigue siendo la del sistema.
  await svc.guardarRevision(9, 2, 44, slim(r.propuesta));
  assert.equal(JSON.parse(store.get('e/c/t/k/x.pdf.propuesta.json')).revision.guardados, 2);
});

test('guardarRevision: no deja editar un planograma ya ACTIVO ni una lectura que no está LISTA', async () => {
  let { svc } = loadSvc({ status: 'ACTIVO' });
  await assert.rejects(svc.guardarRevision(9, 2, 44, slim(propuestaBase())), (e) => e.errorCode === 'ERR_NO_ES_BORRADOR');
  ({ svc } = loadSvc({ doc: { estado: 'PROCESANDO', inicio: new Date().toISOString() } }));
  await assert.rejects(svc.guardarRevision(9, 2, 44, slim(propuestaBase())), (e) => e.errorCode === 'ERR_PROPUESTA_NO_LISTA');
});

test('aprobar: con posiciones sin SKU → 409 y no toca la base', async () => {
  const { svc, calls } = loadSvc();
  await assert.rejects(svc.aprobar(9, 2, 44), (e) => e.errorCode === 'ERR_POSICIONES_SIN_SKU');
  assert.equal(calls.aprobar.length, 0);
});

test('aprobar: completo → manda las filas a la transacción y marca la aprobación en el JSON', async () => {
  const doc = { estado: 'LISTO', formato: 'LISTA_BANDEJAS', propuesta: propuestaBase() };
  doc.propuesta.muebles[0].niveles[0].posiciones[2].sku_id = 30;
  const { svc, calls, store } = loadSvc({ doc });
  const r = await svc.aprobar(9, 2, 44);
  assert.equal(r.filas, 4);
  assert.deepEqual(r.inactivados.map((x) => x.Planogram_seq), [4]);
  assert.equal(calls.aprobar[0].filas.length, 4);
  assert.equal(calls.aprobar[0].seq, 9);
  const guardado = JSON.parse(store.get('e/c/t/k/x.pdf.propuesta.json'));
  assert.equal(guardado.aprobacion.filas, 4);
  await assert.rejects(svc.aprobar(9, 2, 44), (e) => e.errorCode === 'ERR_NO_ES_BORRADOR', 'no se aprueba dos veces');
});

test('buscarSkus: por EAN (sin dígito verificador / con ceros) y por descripción', async () => {
  const { svc } = loadSvc();
  assert.deepEqual((await svc.buscarSkus('750100000034')).map((s) => s.SKU_ID), [30], 'sin el cero de adelante → 0750100000034');
  assert.deepEqual((await svc.buscarSkus('deo')).map((s) => s.SKU_ID), [10, 20, 30]);
  assert.deepEqual(await svc.buscarSkus('x'), []);
});
