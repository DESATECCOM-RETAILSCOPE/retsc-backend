// Ciclo 5 · B3 (Fase 8.2–8.4) — lectura del PDF de planograma, identificación de SKU por código
// y conversión bandeja → mueble/fila.
//
// El test con el PDF real usa el planograma de B0 (Automercado Desodorantes), que NO se sube al
// repo (documento del cliente): se busca en PLANOGRAM_PDF_FIXTURE o en
// "../Automercado Desodorantes pro.plnx.pdf" (carpeta de arriba de Back End). Si no está, ese
// test se salta; los demás corren siempre.
//
// Correr: node src/services/__tests__/planogramProposal.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC  = (p) => require.resolve(path.join(process.cwd(), 'src', p));
const stub = (abs, exports) => { require.cache[abs] = { id: abs, filename: abs, loaded: true, exports }; };
const gtin = require(SRC('utils/gtin.js'));

// ── GTIN ──────────────────────────────────────────────────────────────────────
test('gtin: dígito verificador y validez (casos reales de B0)', () => {
  assert.equal(gtin.checkDigit('81002120001'), 9);          // → 0810021200019 en el catálogo
  assert.equal(gtin.checkDigit('7507734'), 1);              // → 75077341 (EAN-8)
  assert.ok(gtin.isValidGtin('4005808293834'));
  assert.ok(gtin.isValidGtin('0810021200019'));
  assert.ok(!gtin.isValidGtin('81002120001'));              // 11 dígitos: no es GTIN completo
});

test('gtin: candidatos de búsqueda y variantes con ceros', () => {
  assert.deepEqual(gtin.lookupCandidates('81002120001').map((c) => c.tipo), ['EXACTO', 'SIN_VERIFICADOR']);
  assert.equal(gtin.lookupCandidates('81002120001')[1].key, '810021200019');
  assert.ok(gtin.dbVariants('99176370659').includes('0099176370659'));
});

// ── Bandeja → mueble / fila ──────────────────────────────────────────────────
test('mapearBandeja: impar = mueble 1 (izq), par = mueble 2; de abajo hacia arriba → fila 1 = arriba', () => {
  const { mapearBandeja } = loadProposal([]);
  const m = (b) => mapearBandeja(b, { muebles: 2, nivelesPorMueble: 7 });
  assert.deepEqual(m(1),  { shelfunit_id: 1, shelflevel_id: 7 });   // abajo izquierda
  assert.deepEqual(m(2),  { shelfunit_id: 2, shelflevel_id: 7 });   // abajo derecha
  assert.deepEqual(m(13), { shelfunit_id: 1, shelflevel_id: 1 });   // arriba izquierda
  assert.deepEqual(m(14), { shelfunit_id: 2, shelflevel_id: 1 });   // arriba derecha
  assert.throws(() => m(15));
});

// ── Propuesta con catálogo simulado ──────────────────────────────────────────
function loadProposal(catalogo) {
  stub(SRC('repositories/skuRepo.js'), {
    findSkusByEans: async (vars) => catalogo.filter((s) => vars.includes(s.EAN)),
  });
  delete require.cache[SRC('services/planogramProposalService.js')];
  return require(SRC('services/planogramProposalService.js'));
}

const PDF_FAKE = {
  header: { archivo: 'X.plnx', fecha: '2023-07-14', titulos: ['Desodorantes', 'Automercado'] },
  productos: [
    { bandeja: 1, upc: '4005808293834', descripcion: 'NIVEA ROLLON DRY', proveedor: 'BDF', frentes: 1, unidades: 10 },
    { bandeja: 1, upc: '81002120001',   descripcion: 'DR TEALS LAVANDA', proveedor: 'NUTRISOL', frentes: 1, unidades: 13 },
    { bandeja: 2, upc: '99176370659',   descripcion: 'SPEED GEL 2PK', proveedor: 'COLGATE', frentes: 2, unidades: 20 },
    { bandeja: 2, upc: '37000124429',   descripcion: 'SECRET POWER', proveedor: 'P&G', frentes: 2, unidades: 26 },
  ],
  advertencias: [],
};
const CATALOGO = [
  { SKU_ID: 1,  EAN: '4005808293834', Product_dsc: 'NIVEA ROLLON DRY' },
  { SKU_ID: 43, EAN: '0810021200019', Product_dsc: 'DEO DR TEALS BARRA LAVAN' },
  { SKU_ID: 41, EAN: '0099176370659', Product_dsc: '2PACK SPEEDSTICK GEL' },
];

test('propuesta: EXACTO, SIN_VERIFICADOR, SIN_CEROS y NO_ESTA_EN_CATALOGO (sin adivinar por texto)', async () => {
  const { construirPropuestaBase } = loadProposal(CATALOGO);
  const p = await construirPropuestaBase({ pdf: PDF_FAKE, planogramSeq: 5, flowDirection: 'IZQ_DER' });
  const pos = p.muebles.flatMap((m) => m.niveles.flatMap((n) => n.posiciones));
  const by = Object.fromEntries(pos.map((x) => [x.upc, x]));
  assert.equal(by['4005808293834'].match_detalle, 'EXACTO');
  assert.equal(by['81002120001'].match_detalle, 'SIN_VERIFICADOR');
  assert.equal(by['81002120001'].sku_id, 43);
  assert.equal(by['99176370659'].match_detalle, 'SIN_CEROS');
  assert.equal(by['37000124429'].match, 'SIN_MATCH');
  assert.equal(by['37000124429'].estado, 'REVISAR');
  assert.equal(by['37000124429'].sku_id, null);
  assert.deepEqual(p.resumen.detalle_match, { EXACTO: 1, SIN_CEROS: 1, SIN_VERIFICADOR: 1, NO_ESTA_EN_CATALOGO: 1 });
});

test('propuesta: estructura del plan (muebles → niveles → posiciones) con columnas provisorias', async () => {
  const { construirPropuestaBase } = loadProposal(CATALOGO);
  const p = await construirPropuestaBase({ pdf: PDF_FAKE });
  assert.deepEqual(p.muebles.map((m) => m.shelfunit_id), [1, 2]);
  const n = p.muebles[0].niveles[0];
  assert.equal(n.bandeja, 1);
  assert.equal(n.orden_fuente, 'PDF');
  assert.deepEqual(n.posiciones.map((x) => x.shelfcolumn_id), [1, 2]);
  assert.equal(p.resumen.frentes, 6);
});

// ── PDF real (B0) ────────────────────────────────────────────────────────────
const FIXTURE = process.env.PLANOGRAM_PDF_FIXTURE || path.join(process.cwd(), '..', 'Automercado Desodorantes pro.plnx.pdf');
test('PDF real de B0: 180 productos, 303 frentes, 14 bandejas, sin advertencias', { skip: !fs.existsSync(FIXTURE) && `no está ${FIXTURE}` }, async () => {
  delete require.cache[SRC('services/planogramPdfService.js')];
  const { leerPlanogramaPdf } = require(SRC('services/planogramPdfService.js'));
  const r = await leerPlanogramaPdf(fs.readFileSync(FIXTURE));
  assert.equal(r.resumen.productos, 180);
  assert.equal(r.resumen.frentes, 303);
  assert.deepEqual(r.resumen.bandejas, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(r.advertencias, []);
  assert.equal(r.header.fecha, '2023-07-14');
  assert.ok(r.header.titulos.includes('Desodorantes') && r.header.titulos.includes('Automercado'));
  const nivea = r.productos.find((p) => p.upc === '4005900736666');
  assert.equal(nivea.descripcion, 'NIVEA MEN ANTITRANSPIRANTE RLL ON B&W ULT/IMP 50M', 'une la descripción partida en dos líneas');
  assert.equal(nivea.bandeja, 1);
  assert.equal(nivea.frentes, 2);
});
