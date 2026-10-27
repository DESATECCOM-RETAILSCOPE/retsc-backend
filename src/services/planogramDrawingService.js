// Ciclo 5 · B3 (Fase 8.5) — Dibujo del planograma: página 1 del PDF → imagen → repisas.
//
//   renderDibujo(pdfBuffer)      → PNG de la página 1 (respeta la rotación del PDF).
//   detectarRepisas(png)         → muebles (columnas) y niveles (repisas) del dibujo.
//   recortarSegmento(png, box)   → JPEG de UNA repisa de UN mueble (lo que ve el modelo).
//   extraerImagenes(pdfBuffer)   → dónde dibuja el PDF cada imagen de producto (página 1).
//   bloquesDeSegmento(...)       → bloques de producto de una repisa, de izquierda a derecha.
//   recortarConBloques(...)      → el recorte de la repisa con los bloques numerados B1…Bn.
//
// Bloques (8.5, opción B): en este formato cada FRENTE es una imagen embebida en el PDF y el
// mismo producto reutiliza la MISMA imagen. Siguiendo las órdenes de dibujo del PDF se sabe la
// posición exacta de cada imagen; las que se superponen en x son una columna (producto
// apilado) y las columnas seguidas con la misma imagen son un bloque (un producto con varios
// frentes). Un bloque no siempre es 1 producto: hay productos dibujados con 2 imágenes y
// productos que asoman al mueble vecino; por eso el modelo asigna producto → bloque(s).
//
// Detección (B0, formato fijo del programa de planimetría): cada repisa es una BARRA NEGRA
// horizontal gruesa (~20 px a escala 3) debajo de sus productos; las líneas finas son el marco
// de la hoja y se descartan por grosor. Dentro de cada barra, un corte de 1–2 px separa los
// muebles: los tramos oscuros largos de la barra son los muebles, de izquierda a derecha.
// La altura de una repisa va del borde inferior de la barra de arriba al borde superior de la
// suya; la de más arriba usa la altura de la siguiente.
//
// Render: se usa el canvasFactory del propio pdfjs (su copia de @napi-rs/canvas). Mezclar un
// canvas creado con otra versión de @napi-rs/canvas rompe el render (Path2D incompatible).

const sharp = require('sharp');

const DEFAULT_SCALE = 3;
const DARK = 60;                 // gris < 60 = "negro"
const MIN_BAR_ROW_FRACTION = 0.35;
const MIN_BAR_THICKNESS = 8;     // px a escala 3: las barras miden ~20, el marco 1–2
const MIN_SEGMENT_FRACTION = 0.1;

let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

async function renderDibujo(pdfBuffer, { scale = DEFAULT_SCALE } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), verbosity: 0, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale });
  const { canvas, context } = doc.canvasFactory.create(Math.round(viewport.width), Math.round(viewport.height));
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, canvas }).promise;
  const png = canvas.toBuffer('image/png');
  await doc.destroy();
  return { png, width: canvas.width, height: canvas.height };
}

// Tramos consecutivos de `true` en un arreglo → [{ start, end }]
function runs(arr, minLen = 1) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= arr.length; i++) {
    const v = i < arr.length && arr[i];
    if (v && s < 0) s = i;
    if (!v && s >= 0) { if (i - s >= minLen) out.push({ start: s, end: i - 1 }); s = -1; }
  }
  return out;
}

async function detectarRepisas(png) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const dark = (x, y) => data[y * W + x] < DARK;

  // 1) Barras: filas mayormente negras, agrupadas; se quedan las gruesas (repisas).
  const rowIsDark = Array.from({ length: H }, (_, y) => {
    let n = 0;
    for (let x = 0; x < W; x++) if (dark(x, y)) n++;
    return n / W > MIN_BAR_ROW_FRACTION;
  });
  const barras = runs(rowIsDark).filter((r) => r.end - r.start + 1 >= MIN_BAR_THICKNESS);
  if (!barras.length) return { width: W, height: H, muebles: [], niveles: [], segmentos: [], advertencias: ['No se encontraron repisas (barras negras) en el dibujo.'] };

  // 2) Muebles: tramos oscuros largos en la fila del medio de la primera barra.
  const yMid = Math.round((barras[0].start + barras[0].end) / 2);
  const rowDark = Array.from({ length: W }, (_, x) => dark(x, yMid));
  const muebles = runs(rowDark, Math.round(W * MIN_SEGMENT_FRACTION))
    .map((r, i) => ({ shelfunit_id: i + 1, x0: r.start, x1: r.end }));

  // 3) Niveles: de abajo hacia arriba (como el PDF); alto = hasta la barra de arriba.
  const ordenadas = [...barras].sort((a, b) => b.start - a.start);          // abajo → arriba
  const niveles = ordenadas.map((b, i) => {
    const arriba = ordenadas[i + 1];
    const abajo = ordenadas[i - 1];
    // La de más arriba no tiene barra encima: se le da el alto de la repisa de abajo.
    const altoRef = abajo ? abajo.start - b.end - 1 : Math.round(H * 0.1);
    const y0 = arriba ? arriba.end + 1 : Math.max(0, b.start - altoRef);
    return { nivelDesdeAbajo: i + 1, y0, y1: b.start - 1 };
  });

  const segmentos = [];
  for (const n of niveles) for (const m of muebles) {
    segmentos.push({ shelfunit_id: m.shelfunit_id, nivelDesdeAbajo: n.nivelDesdeAbajo, box: { left: m.x0, top: n.y0, width: m.x1 - m.x0 + 1, height: n.y1 - n.y0 + 1 } });
  }
  return { width: W, height: H, muebles, niveles, segmentos, advertencias: [] };
}

async function recortarSegmento(png, box, { maxWidth = 1600 } = {}) {
  let img = sharp(png).extract(box);
  if (box.width > maxWidth) img = img.resize({ width: maxWidth });
  return img.jpeg({ quality: 88 }).toBuffer();
}

// ── Imágenes embebidas ──────────────────────────────────────────────────────
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
function cajaUnidad(m) {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// → [{ id, x0, x1, y0, y1 }] en coordenadas del dibujo a `scale` (misma orientación que renderDibujo).
async function extraerImagenes(pdfBuffer, { scale = DEFAULT_SCALE } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), verbosity: 0, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const { fnArray, argsArray } = await page.getOperatorList();
    const O = pdfjs.OPS;
    const out = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const pila = [];
    const pintar = (id, m) => out.push({ id, ...cajaUnidad(mul(viewport.transform, m)) });
    fnArray.forEach((fn, i) => {
      const a = argsArray[i];
      if (fn === O.save) pila.push(ctm);
      else if (fn === O.restore) ctm = pila.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === O.transform) ctm = mul(ctm, a);
      else if (fn === O.paintImageXObject) pintar(a[0], ctm);
      else if (fn === O.paintImageXObjectRepeat) {
        const [id, sx, sy, pos] = a;
        for (let k = 0; k < pos.length; k += 2) pintar(id, mul(ctm, [sx, 0, 0, sy, pos[k], pos[k + 1]]));
      }
    });
    return out;
  } finally {
    await doc.destroy();
  }
}

// Bloques de UNA repisa (box a la misma escala que `imagenes`) → [{ n, x0, x1, y0, y1, imagenes, ids }]
// agrupar = false → un bloque por COLUMNA (frente), para cuando hay menos bloques que productos
// (dos productos con la misma imagen quedan en un solo bloque).
// incluirBordes = true → también entran las imágenes que se pasan al mueble vecino (≥ 30 % de
// su ancho dentro de la repisa): un producto de esta bandeja puede estar dibujado sobre el corte.
function bloquesDeSegmento(imagenes, box, { agrupar = true, incluirBordes = false } = {}) {
  const dentro = imagenes.filter((im) => {
    const cx = (im.x0 + im.x1) / 2, cy = (im.y0 + im.y1) / 2;
    if (cy < box.top || cy > box.top + box.height) return false;
    if (!incluirBordes) return cx >= box.left && cx < box.left + box.width;
    const solape = Math.min(im.x1, box.left + box.width) - Math.max(im.x0, box.left);
    return solape >= 0.3 * (im.x1 - im.x0);
  }).sort((a, b) => a.x0 - b.x0);

  // Columnas: imágenes que se superponen > 50 % en x (producto apilado).
  const columnas = [];
  for (const im of dentro) {
    const c = columnas[columnas.length - 1];
    const solape = c ? Math.min(c.x1, im.x1) - Math.max(c.x0, im.x0) : -1;
    if (c && solape > 0.5 * Math.min(c.x1 - c.x0, im.x1 - im.x0)) {
      c.x0 = Math.min(c.x0, im.x0); c.x1 = Math.max(c.x1, im.x1);
      c.y0 = Math.min(c.y0, im.y0); c.y1 = Math.max(c.y1, im.y1);
      c.ids.add(im.id); c.imagenes++;
    } else {
      columnas.push({ x0: im.x0, x1: im.x1, y0: im.y0, y1: im.y1, ids: new Set([im.id]), imagenes: 1 });
    }
  }
  // Bloques: columnas seguidas con las mismas imágenes.
  const clave = (c) => [...c.ids].sort().join('|');
  const bloques = [];
  for (const c of columnas) {
    const b = bloques[bloques.length - 1];
    if (agrupar && b && b.clave === clave(c)) {
      b.x1 = Math.max(b.x1, c.x1); b.y0 = Math.min(b.y0, c.y0); b.y1 = Math.max(b.y1, c.y1); b.imagenes += c.imagenes;
    } else {
      bloques.push({ clave: clave(c), x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, imagenes: c.imagenes });
    }
  }
  return bloques.map(({ clave: k, ...b }, i) => ({ n: i + 1, ...b, ids: k.split('|') }));
}

const COLORES = ['#e6007e', '#0070f0', '#00a050', '#f08c00', '#8a2be2', '#00a0a0'];

// Recorte de la repisa con cada bloque enmarcado y numerado (B1…Bn). `box` y `bloques` deben
// estar en coordenadas de `png`.
async function recortarConBloques(png, box, bloques, { maxWidth = 1600 } = {}) {
  const base = await sharp(png).extract(box).toBuffer();
  const etiquetaAlto = Math.max(22, Math.round(box.height * 0.11));
  const fs = Math.round(etiquetaAlto * 0.75);
  const els = bloques.map((b, i) => {
    const x = Math.round(b.x0 - box.left), w = Math.max(4, Math.round(b.x1 - b.x0));
    const y = Math.max(0, Math.round(b.y0 - box.top)), h = Math.min(box.height - y, Math.round(b.y1 - b.y0));
    const color = COLORES[i % COLORES.length];
    const ew = Math.min(w, Math.round(fs * (String(b.n).length * 0.62 + 1.1)));
    const ey = Math.max(0, y - etiquetaAlto);
    return `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${Math.max(2, h - 2)}" fill="none" stroke="${color}" stroke-width="3"/>`
      + `<rect x="${x + 1}" y="${ey}" width="${ew}" height="${etiquetaAlto}" fill="${color}"/>`
      + `<text x="${x + 1 + ew / 2}" y="${ey + etiquetaAlto * 0.78}" font-size="${fs}" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">B${b.n}</text>`;
  });
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}">${els.join('')}</svg>`);
  let img = sharp(await sharp(base).composite([{ input: svg }]).png().toBuffer());
  if (box.width > maxWidth) img = img.resize({ width: maxWidth });
  return img.jpeg({ quality: 88 }).toBuffer();
}

module.exports = { renderDibujo, detectarRepisas, recortarSegmento, runs, extraerImagenes, bloquesDeSegmento, recortarConBloques };
