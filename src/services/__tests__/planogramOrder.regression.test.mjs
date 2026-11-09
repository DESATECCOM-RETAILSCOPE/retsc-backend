// Ciclo 5 · B3 (Fase 8.5) — orden de productos dentro de cada repisa con IA (Azure OpenAI).
//
// Azure OpenAI se reemplaza por un fetch falso: no gasta tokens ni necesita llaves. La prueba
// con el modelo real es scripts/planograma-propuesta.js (correr en la Mac con el .env de QA).
//
// Las pruebas con el PDF real (render, detección de repisas y bloques) usan el planograma de B0,
// que no se sube al repo: PLANOGRAM_PDF_FIXTURE o "../Automercado Desodorantes pro.plnx.pdf".
// Si no está, se saltan.
//
// Correr: node src/services/__tests__/planogramOrder.regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SRC  = (p) => require.resolve(path.join(process.cwd(), 'src', p));
const stub = (abs, exports) => { require.cache[abs] = { id: abs, filename: abs, loaded: true, exports }; };
const ENV = { AZURE_OPENAI_ENDPOINT: 'https://fake.openai.azure.com/', AZURE_OPENAI_KEY: 'k', AZURE_OPENAI_CHAT_DEPLOYMENT: 'gpt-5.4-mini' };

function load({ drawing } = {}) {
  delete require.cache[SRC('services/planogramDrawingService.js')];
  if (drawing) stub(SRC('services/planogramDrawingService.js'), drawing);
  delete require.cache[SRC('services/planogramOrderService.js')];
  return require(SRC('services/planogramOrderService.js'));
}

// fetch falso. estrategia({ modo, ids, nBloques, llamada, body }) → respuesta del modelo
// (objeto), { status } para un error HTTP, o 'TIMEOUT'.
function fakeFetch(estrategia) {
  const llamadas = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    const js = body.response_format.json_schema;
    const modo = js.name === 'candidatos_bloques' ? 'BLOQUES' : 'LIBRE';
    const ids = modo === 'BLOQUES'
      ? js.schema.properties.bloques.items.properties.candidatos.items.enum.filter((x) => x !== 'OTRO')
      : js.schema.properties.orden.items.properties.id.enum;
    const texto = body.messages[1].content[0].text;
    const nBloques = Number(texto.match(/Bloques marcados \((\d+)\)/)?.[1] ?? 0);
    llamadas.push({ url, ids, modo, headers: init.headers, body, signal: init.signal });
    const r = estrategia({ modo, ids, nBloques, llamada: llamadas.length, body });
    if (r === 'TIMEOUT') { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
    if (r?.status) return { ok: false, status: r.status, text: async () => 'error simulado' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(r) } }], usage: { total_tokens: 10 } }) };
  };
  fn.llamadas = llamadas;
  return fn;
}
// Modelo "bueno": BLOQUES → B1 es el último producto, B2 el anterior… (orden inverso al PDF) y
// los bloques que sobran son OTRO; LIBRE → orden inverso.
const inverso = ({ modo, ids, nBloques }) => (modo === 'BLOQUES'
  ? { bloques: Array.from({ length: nBloques }, (_, i) => ({ bloque: i + 1, candidatos: i < ids.length ? [ids[ids.length - 1 - i], 'OTRO'] : ['OTRO'] })) }
  : { orden: [...ids].reverse().map((id, i, a) => ({ id, x_inicio: i / a.length, x_fin: (i + 1) / a.length })) });
const bloquesResp = (lista) => ({ bloques: lista.map((candidatos, i) => ({ bloque: i + 1, candidatos })) });

// Propuesta mínima: 2 muebles × 2 niveles (bandejas 1–4), 3 productos en la bandeja 1.
function propuestaFake() {
  const pos = (n, t) => ({ shelfcolumn_id: n, texto_leido: t, proveedor: 'X', facings: 1, bbox: null });
  return {
    regla_bandejas: { muebles: 2, niveles_por_mueble: 2 },
    muebles: [
      { shelfunit_id: 1, niveles: [
        { shelflevel_id: 1, bandeja: 3, orden_fuente: 'PDF', posiciones: [pos(1, 'A3')] },
        { shelflevel_id: 2, bandeja: 1, orden_fuente: 'PDF', posiciones: [pos(1, 'A'), pos(2, 'B'), pos(3, 'C')] },
      ] },
      { shelfunit_id: 2, niveles: [
        { shelflevel_id: 2, bandeja: 2, orden_fuente: 'PDF', posiciones: [pos(1, 'D'), pos(2, 'E')] },
      ] },
    ],
    resumen: {},
    advertencias: [],
  };
}

// Dibujo falso de 1000×400, 2 muebles × 2 niveles. Cada repisa tiene (productos + 1) bloques de
// 100 px de ancho (salvo `bloquesPorRepisa`), y con agrupar:false el doble (un bloque por frente).
function drawingFake({ muebles = 2, niveles = 2, bloquesPorRepisa = null, sinImagenes = false } = {}) {
  const segmentos = [];
  for (let n = 1; n <= niveles; n++) for (let m = 1; m <= muebles; m++) {
    segmentos.push({ shelfunit_id: m, nivelDesdeAbajo: n, box: { left: (m - 1) * 500, top: 400 - n * 200, width: 500, height: 180 } });
  }
  const llamadasBloques = [];
  return {
    llamadasBloques,
    renderDibujo: async (_buf, { scale }) => ({ png: Buffer.from(`png@${scale}`), width: 1000, height: 400 }),
    detectarRepisas: async () => ({ width: 1000, height: 400, muebles: Array.from({ length: muebles }, (_, i) => ({ shelfunit_id: i + 1 })), niveles: Array.from({ length: niveles }, (_, i) => ({ nivelDesdeAbajo: i + 1 })), segmentos, advertencias: [] }),
    extraerImagenes: async () => (sinImagenes ? [] : [{ id: 'img' }]),
    bloquesDeSegmento: (_imgs, box, { agrupar = true } = {}) => {
      llamadasBloques.push({ box, agrupar });
      const k = (bloquesPorRepisa ?? 4) * (agrupar ? 1 : 2);
      const ancho = box.width / k;
      return Array.from({ length: k }, (_, i) => ({ n: i + 1, x0: box.left + i * ancho, x1: box.left + (i + 1) * ancho, y0: box.top + 20, y1: box.top + box.height, imagenes: 1, ids: [`i${i}`] }));
    },
    recortarSegmento: async () => Buffer.from('jpg'),
    recortarConBloques: async (png, box, bloques) => Buffer.from(JSON.stringify({ png: String(png), box, n: bloques.length })),
  };
}

// ── Validaciones ─────────────────────────────────────────────────────────────
test('validarPermutacion (LIBRE): permutación exacta; rechaza inventados, repetidos y faltantes', () => {
  const { validarPermutacion } = load();
  const ids = ['P1', 'P2', 'P3'];
  assert.ok(validarPermutacion({ orden: [{ id: 'P2' }, { id: 'P3' }, { id: 'P1' }] }, ids).ok);
  assert.match(validarPermutacion({ orden: [{ id: 'P1' }, { id: 'P2' }, { id: 'P9' }] }, ids).motivo, /desconocido/);
  assert.match(validarPermutacion({ orden: [{ id: 'P1' }, { id: 'P1' }, { id: 'P2' }] }, ids).motivo, /repetido/);
  assert.match(validarPermutacion({ orden: [{ id: 'P1' }, { id: 'P2' }] }, ids).motivo, /Faltan ids: P3/);
  assert.equal(validarPermutacion({}, ids).ok, false);
});

test('validarCandidatos: todos los bloques una vez; descarta ids inventados; máx. 3 candidatos', () => {
  const { validarCandidatos } = load();
  const ids = ['P1', 'P2'];
  const ok = validarCandidatos(bloquesResp([['P2', 'P9', 'P1', 'OTRO'], ['OTRO'], ['P1']]), ids, 3);
  assert.ok(ok.ok);
  assert.deepEqual(ok.candidatos.slice(1), [['P2', 'P1', 'OTRO'], ['OTRO'], ['P1']]);
  assert.match(validarCandidatos(bloquesResp([['P1'], ['P2']]), ids, 3).motivo, /Faltan bloques: B3/);
  assert.match(validarCandidatos({ bloques: [{ bloque: 1, candidatos: ['P1'] }, { bloque: 1, candidatos: ['P2'] }] }, ids, 2).motivo, /B1 aparece dos veces/);
  assert.match(validarCandidatos({ bloques: [{ bloque: 4, candidatos: ['P1'] }] }, ids, 3).motivo, /inexistente/);
  assert.match(validarCandidatos(bloquesResp([['P9'], ['P1']]), ids, 2).motivo, /B1 sin candidatos/);
});

test('hungaro: asignación de costo mínimo (filas ≤ columnas)', () => {
  const { hungaro } = load();
  const a = hungaro([[0, 1, 6], [0, 6, 1]]);
  assert.notEqual(a[0], a[1]);
  assert.equal([[0, 1, 6], [0, 6, 1]][0][a[0]] + [[0, 1, 6], [0, 6, 1]][1][a[1]], 1);
  assert.deepEqual(hungaro([[5, 0, 9], [0, 9, 9], [9, 9, 0]]), [1, 0, 2]);
});

test('resolverAsignacion: conflicto (dos bloques eligen P1) se resuelve con el 2.º candidato', () => {
  const { resolverAsignacion } = load();
  // B1 y B2 creen que son P1; B2 tiene a P2 como 2.º candidato → P1=B1, P2=B2 (MEDIA).
  const r = resolverAsignacion([null, ['P1', 'P2'], ['P1', 'P2'], ['OTRO']], ['P1', 'P2']);
  assert.deepEqual(r.asignacion, [{ id: 'P1', desde: 1, hasta: 1, confianza: 'ALTA' }, { id: 'P2', desde: 2, hasta: 2, confianza: 'MEDIA' }]);
  assert.deepEqual(r.sobrantes, [3]);
});

test('resolverAsignacion: un producto con varias imágenes se extiende a los bloques vecinos', () => {
  const { resolverAsignacion } = load();
  const r = resolverAsignacion([null, ['P2'], ['P1'], ['P1'], ['P1', 'OTRO'], ['OTRO']], ['P1', 'P2']);
  assert.deepEqual(r.asignacion, [{ id: 'P2', desde: 1, hasta: 1, confianza: 'ALTA' }, { id: 'P1', desde: 2, hasta: 4, confianza: 'ALTA' }]);
  assert.deepEqual(r.sobrantes, [5]);
});

test('resolverAsignacion: producto que el modelo no listó en ningún bloque → BAJA (igual se ubica)', () => {
  const { resolverAsignacion } = load();
  const r = resolverAsignacion([null, ['P1'], ['P1'], ['OTRO']], ['P1', 'P2']);
  const p2 = r.asignacion.find((a) => a.id === 'P2');
  assert.equal(p2.confianza, 'BAJA');
  assert.equal(r.asignacion.length, 2);
});

// ── Llamadas al modelo ───────────────────────────────────────────────────────
test('asignarBloques: deployment, api-key, imagen, schema con ids cerrados, timeout y lista de bloques', async () => {
  const { asignarBloques, configOpenAI } = load();
  const f = fakeFetch(inverso);
  const r = await asignarBloques({ cfg: configOpenAI(ENV), imagenJpeg: Buffer.from('jpg'), productos: [{ id: 'P1', descripcion: 'A' }, { id: 'P2', descripcion: 'B' }], bloques: [{ n: 1, imagenes: 2 }, { n: 2, imagenes: 1 }, { n: 3, imagenes: 1 }], fetchImpl: f });
  assert.ok(r.ok);
  assert.deepEqual(r.asignacion.map((a) => a.id), ['P2', 'P1']);
  assert.ok(r.asignacion.every((a) => a.confianza === 'ALTA'));
  assert.deepEqual(r.sobrantes, [3]);
  const c = f.llamadas[0];
  assert.equal(c.url, 'https://fake.openai.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2025-04-01-preview');
  assert.equal(c.headers['api-key'], 'k');
  assert.equal(c.body.response_format.json_schema.strict, true);
  assert.deepEqual(c.ids, ['P1', 'P2']);
  assert.ok(c.signal, 'lleva AbortSignal (timeout)');
  assert.match(c.body.messages[1].content[0].text, /B1 \(2 imágenes\), B2 \(1 imagen\), B3 \(1 imagen\)/);
  assert.ok(c.body.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
  assert.equal(c.body.temperature, undefined, 'gpt-5.x no acepta temperature');
});

test('corrección: si la respuesta no valida, se le devuelve el error al modelo en el 2.º intento', async () => {
  const { asignarBloques, configOpenAI } = load();
  const f = fakeFetch((a) => (a.llamada === 1 ? bloquesResp([['P1'], ['P2']]) : inverso(a)));
  const r = await asignarBloques({ cfg: configOpenAI(ENV), imagenJpeg: Buffer.from('x'), productos: [{ id: 'P1' }, { id: 'P2' }], bloques: [{ n: 1, imagenes: 1 }, { n: 2, imagenes: 1 }, { n: 3, imagenes: 1 }], fetchImpl: f, esperaMs: 0 });
  assert.ok(r.ok);
  assert.equal(r.intentos, 2);
  const msgs = f.llamadas[1].body.messages;
  assert.equal(msgs.at(-2).role, 'assistant');
  assert.match(msgs.at(-1).content, /Faltan bloques: B3/);
});

test('reintentos: timeout y 429 se reintentan; 400 no; 2 fallas → ok:false', async () => {
  const { ordenarRepisa, configOpenAI } = load();
  const productos = [{ id: 'P1' }, { id: 'P2' }];
  const cfg = configOpenAI(ENV);
  let f = fakeFetch((a) => (a.llamada === 1 ? 'TIMEOUT' : inverso(a)));
  assert.ok((await ordenarRepisa({ cfg, imagenJpeg: Buffer.from('x'), productos, fetchImpl: f, esperaMs: 0 })).ok);
  f = fakeFetch((a) => (a.llamada === 1 ? { status: 429 } : inverso(a)));
  assert.ok((await ordenarRepisa({ cfg, imagenJpeg: Buffer.from('x'), productos, fetchImpl: f, esperaMs: 0 })).ok);
  f = fakeFetch(() => ({ status: 400 }));
  let r = await ordenarRepisa({ cfg, imagenJpeg: Buffer.from('x'), productos, fetchImpl: f, esperaMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(f.llamadas.length, 1);
  f = fakeFetch(() => 'TIMEOUT');
  r = await ordenarRepisa({ cfg, imagenJpeg: Buffer.from('x'), productos, fetchImpl: f, esperaMs: 0 });
  assert.match(r.motivo, /no respondió en 90 s/);
  assert.equal(f.llamadas.length, 2);
});

// ── Propuesta completa ──────────────────────────────────────────────────────
test('BLOQUES: orden por posición del bloque, bbox exacto de los bloques, sobrantes y progreso', async () => {
  const d = drawingFake();
  const { ordenarPropuesta } = load({ drawing: d });
  const f = fakeFetch(inverso);
  const progreso = [];
  const { propuesta: p, dibujoPng } = await ordenarPropuesta({ propuesta: propuestaFake(), pdfBuffer: Buffer.from('pdf'), fetchImpl: f, env: ENV, onRepisa: (x) => progreso.push(x) });
  const n = p.muebles[0].niveles.find((x) => x.bandeja === 1);
  assert.deepEqual(n.posiciones.map((x) => x.texto_leido), ['C', 'B', 'A']);
  assert.deepEqual(n.posiciones.map((x) => x.shelfcolumn_id), [1, 2, 3]);
  assert.deepEqual(n.posiciones.map((x) => x.bloques), [[1, 1], [2, 2], [3, 3]]);
  assert.equal(n.orden_metodo, 'BLOQUES');
  assert.equal(n.orden_estado, 'OK');
  assert.deepEqual(n.orden_confianza, { ALTA: 3, MEDIA: 0, BAJA: 0 });
  assert.ok(n.posiciones.every((x) => x.orden_confianza === 'ALTA'));
  assert.deepEqual(n.bloques_sobrantes, [4]);
  // Bandeja 1 = mueble 1, nivel 1 desde abajo → box {0, 200, 500×180}; 4 bloques de 125 px; y0 = 220.
  assert.deepEqual(n.posiciones[0].bbox, { x: 0, y: 0.55, w: 0.125, h: 0.4 });
  assert.equal(f.llamadas.length, 3, 'las 3 repisas (la de 1 producto tiene 4 bloques: también pregunta)');
  assert.ok(f.llamadas.every((c) => c.modo === 'BLOQUES'));
  assert.deepEqual(p.resumen.orden, { niveles: 3, ordenados_ia: 3, por_bloques: 3, a_revisar: 0, confianza: { ALTA: 6, MEDIA: 0, BAJA: 0 } });
  assert.equal(progreso.length, 3);
  assert.ok(progreso.every((x) => x.metodo === 'BLOQUES' && x.estado === 'OK'));
  assert.equal(String(dibujoPng), 'png@3');
});

test('BLOQUES: si el modelo no reconoce un producto, la repisa queda REVISAR (pero ordenada)', async () => {
  const { ordenarPropuesta } = load({ drawing: drawingFake() });
  const f = fakeFetch((a) => bloquesResp(Array.from({ length: a.nBloques }, (_, i) => (i === 0 ? ['P1'] : ['OTRO']))));
  const { propuesta: p } = await ordenarPropuesta({ propuesta: propuestaFake(), pdfBuffer: Buffer.from('pdf'), fetchImpl: f, env: ENV });
  const n = p.muebles[0].niveles.find((x) => x.bandeja === 1);
  assert.equal(n.orden_metodo, 'BLOQUES');
  assert.equal(n.orden_estado, 'REVISAR');
  assert.deepEqual(n.orden_confianza, { ALTA: 1, MEDIA: 0, BAJA: 2 });
  assert.equal(n.posiciones[0].texto_leido, 'A');
});

test('BLOQUES: el recorte marcado sale del render de alta resolución (cajas escaladas ×2)', async () => {
  const d = drawingFake();
  const cajas = [];
  d.recortarConBloques = async (png, box, bloques) => { cajas.push({ png: String(png), box, x0: bloques[0].x0 }); return Buffer.from('x'); };
  const { ordenarPropuesta } = load({ drawing: d });
  await ordenarPropuesta({ propuesta: propuestaFake(), pdfBuffer: Buffer.from('pdf'), fetchImpl: fakeFetch(inverso), env: ENV });
  const b1 = cajas.find((c) => c.box.top === 400 && c.box.left === 0);
  assert.ok(b1);
  assert.equal(b1.png, 'png@6');
  assert.equal(b1.box.width, 1000);
});

test('BLOQUES: si hay menos bloques que productos, usa un bloque por frente (agrupar:false)', async () => {
  const d = drawingFake({ bloquesPorRepisa: 2 });                 // 2 bloques < 3 productos en la bandeja 1
  const { ordenarPropuesta } = load({ drawing: d });
  const { propuesta: p } = await ordenarPropuesta({ propuesta: propuestaFake(), pdfBuffer: Buffer.from('pdf'), fetchImpl: fakeFetch(inverso), env: ENV });
  const n = p.muebles[0].niveles.find((x) => x.bandeja === 1);
  assert.equal(n.orden_metodo, 'BLOQUES');
  assert.equal(n.bloques_total, 4);
  assert.ok(d.llamadasBloques.some((c) => c.agrupar === false));
});

test('respaldo LIBRE: si BLOQUES falla, ordena sin bloques y queda REVISAR', async () => {
  const { ordenarPropuesta } = load({ drawing: drawingFake() });
  const f = fakeFetch((a) => (a.modo === 'BLOQUES' ? { bloques: [] } : inverso(a)));
  const { propuesta: p } = await ordenarPropuesta({ propuesta: propuestaFake(), pdfBuffer: Buffer.from('pdf'), fetchImpl: f, env: ENV });
  const n = p.muebles[0].niveles.find((x) => x.bandeja === 1);
  assert.deepEqual(n.posiciones.map((x) => x.texto_leido), ['C', 'B', 'A']);
  assert.equal(n.orden_fuente, 'IA');
  assert.equal(n.orden_metodo, 'LIBRE');
  assert.equal(n.orden_estado, 'REVISAR');
  assert.match(n.orden_motivo, /Faltan bloques/);
});

test('respaldo LIBRE: sin imágenes ubicables en el PDF', async () => {
  const { ordenarPropuesta } = load({ drawing: drawingFake({ sinImagenes: true }) });
  const f = fakeFetch(inverso);
  const { propuesta: p } = await ordenarPropuesta({ propuesta: propuestaFake(), pdfBuffer: Buffer.from('pdf'), fetchImpl: f, env: ENV });
  assert.ok(f.llamadas.every((c) => c.modo === 'LIBRE'));
  assert.equal(p.muebles[0].niveles.find((x) => x.bandeja === 1).orden_metodo, 'LIBRE');
});

test('si fallan BLOQUES y LIBRE: orden de la lista del PDF y REVISAR', async () => {
  const { ordenarPropuesta } = load({ drawing: drawingFake() });
  const { propuesta: p } = await ordenarPropuesta({ propuesta: propuestaFake(), pdfBuffer: Buffer.from('pdf'), fetchImpl: fakeFetch(() => ({ status: 400 })), env: ENV });
  const n = p.muebles[0].niveles.find((x) => x.bandeja === 1);
  assert.deepEqual(n.posiciones.map((x) => x.texto_leido), ['A', 'B', 'C']);
  assert.equal(n.orden_fuente, 'PDF');
  assert.equal(n.orden_estado, 'REVISAR');
  assert.match(n.orden_motivo, /Azure OpenAI 400/);
  assert.equal(p.resumen.orden.a_revisar, 3);
});

test('dibujo con otra cantidad de muebles/niveles → no adivina, todo a revisar', async () => {
  const { ordenarPropuesta } = load({ drawing: drawingFake({ niveles: 3 }) });
  const f = fakeFetch(inverso);
  const { propuesta: p } = await ordenarPropuesta({ propuesta: propuestaFake(), pdfBuffer: Buffer.from('pdf'), fetchImpl: f, env: ENV });
  assert.equal(f.llamadas.length, 0);
  assert.ok(p.advertencias.some((a) => /2 mueble\(s\) × 3 repisa\(s\).*2 × 2/.test(a)));
  assert.equal(p.resumen.orden.a_revisar, 3);
});

test('sin AZURE_OPENAI_CHAT_DEPLOYMENT no llama a nada y avisa', async () => {
  const { ordenarPropuesta } = load({ drawing: drawingFake() });
  const f = fakeFetch(inverso);
  const { propuesta: p } = await ordenarPropuesta({ propuesta: propuestaFake(), pdfBuffer: Buffer.from('pdf'), fetchImpl: f, env: { ...ENV, AZURE_OPENAI_CHAT_DEPLOYMENT: '' } });
  assert.equal(f.llamadas.length, 0);
  assert.ok(p.advertencias.some((a) => /no configurado/.test(a)));
  assert.equal(p.muebles[0].niveles[1].orden_estado, 'REVISAR');
});

// ── PDF real (B0) ────────────────────────────────────────────────────────────
const FIXTURE = process.env.PLANOGRAM_PDF_FIXTURE || path.join(process.cwd(), '..', 'Automercado Desodorantes pro.plnx.pdf');
const sinFixture = !fs.existsSync(FIXTURE) && `no está ${FIXTURE}`;
const drawingReal = () => { delete require.cache[SRC('services/planogramDrawingService.js')]; return require(SRC('services/planogramDrawingService.js')); };

test('PDF real de B0: el dibujo tiene 2 muebles × 7 repisas (= 14 bandejas)', { skip: sinFixture }, async () => {
  const drawing = drawingReal();
  const d = await drawing.renderDibujo(fs.readFileSync(FIXTURE));
  const r = await drawing.detectarRepisas(d.png);
  assert.equal(r.muebles.length, 2);
  assert.equal(r.niveles.length, 7);
  assert.equal(r.segmentos.length, 14);
  assert.deepEqual(r.advertencias, []);
  assert.ok(r.muebles[0].x1 < r.muebles[1].x0, 'mueble 1 a la izquierda');
});

test('PDF real de B0: 304 imágenes ubicadas; toda repisa tiene bloques suficientes', { skip: sinFixture }, async () => {
  const drawing = drawingReal();
  const buf = fs.readFileSync(FIXTURE);
  const { leerPlanogramaPdf } = require(SRC('services/planogramPdfService.js'));
  const pdf = await leerPlanogramaPdf(buf);
  const d = await drawing.renderDibujo(buf);
  const det = await drawing.detectarRepisas(d.png);
  const imgs = await drawing.extraerImagenes(buf);
  assert.equal(imgs.length, 304);
  for (const s of det.segmentos) {
    const bandeja = (s.nivelDesdeAbajo - 1) * 2 + s.shelfunit_id;
    const productos = pdf.productos.filter((p) => p.bandeja === bandeja).length;
    let b = drawing.bloquesDeSegmento(imgs, s.box, { incluirBordes: true });
    if (b.length < productos) b = drawing.bloquesDeSegmento(imgs, s.box, { incluirBordes: true, agrupar: false });
    assert.ok(b.length >= productos, `bandeja ${bandeja}: ${b.length} bloques para ${productos} productos`);
    assert.ok(b.every((x, i) => i === 0 || x.x0 >= b[i - 1].x0), `bandeja ${bandeja}: bloques de izquierda a derecha`);
  }
});
