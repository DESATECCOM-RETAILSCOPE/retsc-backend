// Ciclo 5 · B2 — carga de planogramas (planogramService.createDraft).
// Ciclo 5 · B3 (8.1/8.6) — carga de PDF + interpretación en segundo plano (estado en el blob).
//   · validaciones: tienda de la cadena, vigencia, dirección, categoría habilitada, imagen, formato
//   · ruta del blob {EMPRESA}/{CADENA}/{TIENDA}/{CATEGORIA}/{yyyyMMdd}_{guid8}.jpg
//   · INSERT en BORRADOR con Formato de la tienda, Loaded_userid y URL_picture = ruta del blob
// Sin BD ni Azure. Correr: node src/services/__tests__/planogramUpload.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC  = (p) => require.resolve(path.join(process.cwd(), 'src', p));
const stub = (abs, exports) => { require.cache[abs] = { id: abs, filename: abs, loaded: true, exports }; };

function load({
  tienda = { Retailer_id: 9, Retailer_dsc: 'Más x Menos Escazú', Supermarketchain_id: 3, Formato: 'HIPER' },
  planograma = null,                       // fila que devuelve findBySeq (default: BORRADOR sin archivo)
  interpretar = async () => ({ formato: 'SPACE_PLANNING', propuesta: { resumen: { posiciones: 3 }, muebles: [] }, dibujoPng: Buffer.from('png') }),
} = {}) {
  const calls = { upload: [], insert: [], ensure: [], interpretar: [] };
  const store = new Map();                 // blob en memoria: ruta → Buffer
  stub(SRC('repositories/planogramRepo.js'), {
    findChainById: async (id) => (id === 3 ? { Supermarketchain_id: 3, Supermarketchain: 'Walmart CR' } : null),
    insertDraft: async (row) => { calls.insert.push(row); return 501; },
    findBySeq: async (seq) => planograma ?? ({ Planogram_seq: seq, Status: 'BORRADOR', URL_picture: calls.insert[0]?.urlPicture ?? null, Flow_direction: 'IZQ_DER' }),
  });
  stub(SRC('repositories/skuRepo.js'), { findSkusByIds: async () => [], searchSkus: async () => [] });
  stub(SRC('services/planogramInterpretService.js'), {
    interpretarPdf: async (args) => { calls.interpretar.push(args); return interpretar(args); },
  });
  stub(SRC('repositories/retailerRepo.js'), { findById: async (id) => (id === 9 ? tienda : null) });
  stub(SRC('repositories/enterpriseRepo.js'), { findById: async () => ({ Enterprise_dsc: 'Unilever Centroamérica' }) });
  stub(SRC('repositories/enterpriseCategoryRepo.js'), {
    listSmartForEnterprise: async () => [{ category_id: 7, category_dsc: 'Desodorantes Corporales' }],
  });
  stub(SRC('services/blobStorageService.js'), {
    ensureContainerExists: async (c) => { calls.ensure.push(c); },
    uploadToContainer: async (args) => { calls.upload.push(args); store.set(args.blobPath, args.buffer); return { url: 'x', mode: 'mock' }; },
    downloadFromContainer: async ({ blobPath }) => {
      if (!store.has(blobPath)) throw Object.assign(new Error('no existe'), { code: 'ENOENT' });
      return store.get(blobPath);
    },
  });
  delete require.cache[SRC('services/planogramCodeMapService.js')];   // usa el blob simulado de arriba
  delete require.cache[SRC('services/planogramService.js')];
  return { svc: require(SRC('services/planogramService.js')), calls, store };
}
const PDF = Buffer.from('%PDF-1.7 prueba');
const esperar = async (cond, ms = 2000) => {
  const t0 = Date.now();
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error('timeout esperando'); await new Promise((r) => setTimeout(r, 10)); }
};

const OK = {
  enterpriseId: 2, userId: 44, categoryId: '7', supermarketchainId: '3', retailerId: '9',
  upDate: '2026-11-01', downDate: '', flowDirection: 'IZQ_DER', notes: 'Pasillo 4',
  buffer: Buffer.from('img'), mimetype: 'image/jpeg',
};
const rejectsWith = (p, code) => assert.rejects(p, (e) => e.statusCode === 400 && e.errorCode === code);

test('carga válida → blob con nombres legibles y fila en BORRADOR', async () => {
  const { svc, calls } = load();
  const r = await svc.createDraft(OK);
  assert.equal(r.Status, 'BORRADOR');
  assert.deepEqual(calls.ensure, ['enterprise-planograms']);
  assert.match(calls.upload[0].blobPath,
    /^Unilever-Centroamerica\/Walmart-CR\/Mas-x-Menos-Escazu\/Desodorantes-Corporales\/\d{8}_[0-9a-f]{8}\.jpg$/);
  const row = calls.insert[0];
  assert.equal(row.formato, 'HIPER', 'el formato sale de la tienda');
  assert.equal(row.loadedUserId, 44);
  assert.equal(row.urlPicture, calls.upload[0].blobPath);
  assert.equal(row.downDate, null);
  assert.equal(row.flowDirection, 'IZQ_DER');
});

test('PNG → extensión .png y content-type image/png', async () => {
  const { svc, calls } = load();
  await svc.createDraft({ ...OK, mimetype: 'image/png' });
  assert.match(calls.upload[0].blobPath, /\.png$/);
  assert.equal(calls.upload[0].contentType, 'image/png');
});

test('tienda de otra cadena → 400 y no sube nada', async () => {
  const { svc, calls } = load({ tienda: { Retailer_id: 9, Retailer_dsc: 'X', Supermarketchain_id: 99, Formato: 'HIPER' } });
  await rejectsWith(svc.createDraft(OK), 'ERR_TIENDA_NO_ES_DE_LA_CADENA');
  assert.equal(calls.upload.length, 0);
});

test('vigencia hasta < desde → 400', async () => {
  const { svc } = load();
  await rejectsWith(svc.createDraft({ ...OK, downDate: '2026-10-01' }), 'ERR_VIGENCIA_INVALIDA');
});

test('fecha inválida → 400', async () => {
  const { svc } = load();
  await rejectsWith(svc.createDraft({ ...OK, upDate: '2026-02-30' }), 'ERR_FECHA_INVALIDA');
});

test('dirección inválida → 400', async () => {
  const { svc } = load();
  await rejectsWith(svc.createDraft({ ...OK, flowDirection: 'ARRIBA' }), 'ERR_DIRECCION_INVALIDA');
});

test('categoría no habilitada para la empresa → 400', async () => {
  const { svc } = load();
  await rejectsWith(svc.createDraft({ ...OK, categoryId: '8' }), 'ERR_CATEGORIA_NO_HABILITADA');
});

test('imagen WEBP → 400 (solo PDF/JPG/PNG)', async () => {
  const { svc } = load();
  await rejectsWith(svc.createDraft({ ...OK, mimetype: 'image/webp' }), 'ERR_FORMATO_NO_SOPORTADO');
});

test('formato de tienda > 30 caracteres → 400 con indicación de la migración 020', async () => {
  const { svc, calls } = load({ tienda: { Retailer_id: 9, Retailer_dsc: 'X', Supermarketchain_id: 3, Formato: 'SUPERMERCADO DE CONVENIENCIA EXPRESS' } });
  await assert.rejects(svc.createDraft(OK), (e) => e.errorCode === 'ERR_FORMATO_DEMASIADO_LARGO' && /020/.test(e.message));
  assert.equal(calls.upload.length, 0);
});

test('notas de más de 255 caracteres → 400', async () => {
  const { svc } = load();
  await rejectsWith(svc.createDraft({ ...OK, notes: 'x'.repeat(256) }), 'ERR_NOTAS_DEMASIADO_LARGAS');
});

// ── Ciclo 5: planograma para TODAS las tiendas de la cadena ───────────────────
test('tienda vacía → planograma de toda la cadena: Retailer_id NULL, sin formato, carpeta todas-las-tiendas', async () => {
  const { svc, calls } = load();
  await svc.createDraft({ ...OK, retailerId: '' });
  const row = calls.insert[0];
  assert.equal(row.retailerId, null);
  assert.equal(row.formato, null);
  assert.equal(row.supermarketchainId, 3, 'la cadena sigue siendo obligatoria');
  assert.match(calls.upload[0].blobPath, /^Unilever-Centroamerica\/Walmart-CR\/todas-las-tiendas\/Desodorantes-Corporales\//);
});

test('retailerId "TODAS" también significa toda la cadena', async () => {
  const { svc, calls } = load();
  await svc.createDraft({ ...OK, retailerId: 'TODAS' });
  assert.equal(calls.insert[0].retailerId, null);
});

test('toda la cadena con una cadena inexistente → 400', async () => {
  const { svc } = load();
  await rejectsWith(svc.createDraft({ ...OK, retailerId: '', supermarketchainId: '77' }), 'ERR_CADENA_NO_EXISTE');
});

test('cadena vacía → 400 (la cadena es obligatoria aunque la tienda no)', async () => {
  const { svc } = load();
  await rejectsWith(svc.createDraft({ ...OK, retailerId: '', supermarketchainId: '' }), 'ERR_CAMPO_REQUERIDO');
});

// ── Fase 8.1 / 8.6: PDF + interpretación ─────────────────────────────────────
test('PDF → se sube como .pdf (application/pdf) y se interpreta en segundo plano hasta LISTO', async () => {
  const { svc, calls, store } = load();
  const r = await svc.createDraft({ ...OK, buffer: PDF, mimetype: 'application/pdf' });
  assert.equal(r.Status, 'BORRADOR');
  const pdfPath = calls.upload[0].blobPath;
  assert.match(pdfPath, /\.pdf$/);
  assert.equal(calls.upload[0].contentType, 'application/pdf');
  await esperar(async () => (await svc.getPropuesta(501, 2)).estado === 'LISTO');
  const doc = await svc.getPropuesta(501, 2);
  assert.equal(doc.formato, 'SPACE_PLANNING');
  assert.equal(doc.propuesta.resumen.posiciones, 3);
  assert.ok(store.has(`${pdfPath}.dibujo.png`), 'guarda el dibujo junto al PDF');
  assert.equal(String(await svc.getDibujo(501, 2)), 'png');
  assert.equal(calls.interpretar[0].planogramSeq, 501);
  assert.equal(calls.interpretar[0].flowDirection, 'IZQ_DER');
});

test('PDF: mientras interpreta el estado es PROCESANDO', async () => {
  let soltar;
  const { svc } = load({ interpretar: () => new Promise((res) => { soltar = () => res({ formato: 'X', propuesta: { resumen: { posiciones: 0 } }, dibujoPng: Buffer.from('p') }); }) });
  await svc.createDraft({ ...OK, buffer: PDF, mimetype: 'application/pdf' });
  assert.equal((await svc.getPropuesta(501, 2)).estado, 'PROCESANDO');
  await esperar(() => typeof soltar === 'function');
  soltar();
  await esperar(async () => (await svc.getPropuesta(501, 2)).estado === 'LISTO');
});

test('PDF: si la interpretación falla, queda ERROR con el código y el mensaje', async () => {
  const { svc } = load({ interpretar: async () => { throw Object.assign(new Error('No se reconoce el formato del PDF.'), { errorCode: 'ERR_FORMATO_PLANOGRAMA_DESCONOCIDO' }); } });
  const r = await svc.createDraft({ ...OK, buffer: PDF, mimetype: 'application/pdf' });
  assert.equal(r.Status, 'BORRADOR', 'el planograma queda creado igual');
  await esperar(async () => (await svc.getPropuesta(501, 2)).estado === 'ERROR');
  const doc = await svc.getPropuesta(501, 2);
  assert.equal(doc.errorCode, 'ERR_FORMATO_PLANOGRAMA_DESCONOCIDO');
  assert.match(doc.mensaje, /formato/);
});

test('archivo .pdf que no es PDF → 400 ERR_PDF_INVALIDO y no sube nada', async () => {
  const { svc, calls } = load();
  await rejectsWith(svc.createDraft({ ...OK, buffer: Buffer.from('hola'), mimetype: 'application/pdf' }), 'ERR_PDF_INVALIDO');
  assert.equal(calls.upload.length, 0);
});

test('getPropuesta: imagen → NO_APLICA; PDF sin JSON → SIN_INTERPRETAR; PROCESANDO viejo → ERROR interrumpida', async () => {
  let { svc } = load({ planograma: { Planogram_seq: 7, Status: 'BORRADOR', URL_picture: 'a/b/c.jpg' } });
  assert.equal((await svc.getPropuesta(7, 2)).estado, 'NO_APLICA');
  ({ svc } = load({ planograma: { Planogram_seq: 7, Status: 'BORRADOR', URL_picture: 'a/b/c.pdf' } }));
  assert.equal((await svc.getPropuesta(7, 2)).estado, 'SIN_INTERPRETAR');
  const l = load({ planograma: { Planogram_seq: 7, Status: 'BORRADOR', URL_picture: 'a/b/c.pdf' } });
  l.store.set('a/b/c.pdf.propuesta.json', Buffer.from(JSON.stringify({ estado: 'PROCESANDO', inicio: new Date(Date.now() - 11 * 60_000).toISOString() })));
  const doc = await l.svc.getPropuesta(7, 2);
  assert.equal(doc.estado, 'ERROR');
  assert.equal(doc.errorCode, 'ERR_INTERPRETACION_INTERRUMPIDA');
});

test('reinterpretar: vuelve a correr sobre el PDF guardado; solo BORRADOR y solo PDF', async () => {
  const l = load({ planograma: { Planogram_seq: 7, Status: 'BORRADOR', URL_picture: 'a/b/c.pdf', Flow_direction: 'DER_IZQ' } });
  l.store.set('a/b/c.pdf', PDF);
  assert.deepEqual(await l.svc.reinterpretar(7, 2), { estado: 'PROCESANDO' });
  await esperar(async () => (await l.svc.getPropuesta(7, 2)).estado === 'LISTO');
  assert.equal(String(l.calls.interpretar[0].buffer), String(PDF));
  assert.equal(l.calls.interpretar[0].flowDirection, 'DER_IZQ');

  const activo = load({ planograma: { Planogram_seq: 7, Status: 'ACTIVO', URL_picture: 'a/b/c.pdf' } });
  await assert.rejects(activo.svc.reinterpretar(7, 2), (e) => e.errorCode === 'ERR_NO_ES_BORRADOR');
  const img = load({ planograma: { Planogram_seq: 7, Status: 'BORRADOR', URL_picture: 'a/b/c.png' } });
  await assert.rejects(img.svc.reinterpretar(7, 2), (e) => e.errorCode === 'ERR_NO_ES_PDF');
});
