// Ciclo 5 · B3 — Lectura del PDF de planograma exportado por el programa de planimetría.
//
// Formato (B0, confirmado "siempre este formato"):
//   · Página 1: dibujo del planograma (muebles × repisas, fotos de empaques). Título con la
//     categoría y la cadena, fecha dd/mm/aaaa.
//   · Páginas 2..n: "Product List" — por producto: Product_ID, UPC, Descripción, Proveedor,
//     Frentes, Total_Units, agrupados por "Bandeja: N". Texto seleccionable.
//
// El texto se lee con pdfjs-dist por POSICIÓN: las columnas se detectan por la coordenada x de
// los valores en cada página (adaptativo, no coordenadas fijas), y cada producto se ancla en su
// UPC. El Product_ID viene partido en dos líneas en el PDF; no se usa (el UPC es la clave).
//
// pdfjs-dist 5.x es ESM → se carga con import() dinámico desde este módulo CommonJS. En Node
// necesita @napi-rs/canvas (polyfill de DOMMatrix); ambas son dependencias del proyecto.

const LABELS = /^(Product_ID|UPC|Descripci[oó]n|Proveedor|Frentes|Total_Units|Fixel_ID|Product List)$/i;
const isNum = (s) => /^\d+$/.test(s);

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function openPdf(buffer) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
}

async function pageItems(doc, n) {
  const page = await doc.getPage(n);
  const tc = await page.getTextContent();
  return tc.items
    .map((i) => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] }))
    .filter((i) => i.s);
}

// Agrupa valores de x cercanos (±tol) y devuelve los centros ordenados por cantidad de items.
function clusters(xs, tol = 8) {
  const groups = [];
  for (const x of xs.sort((a, b) => a - b)) {
    const g = groups.find((gr) => Math.abs(gr.center - x) <= tol);
    if (g) { g.xs.push(x); g.center = g.xs.reduce((a, b) => a + b, 0) / g.xs.length; }
    else groups.push({ center: x, xs: [x] });
  }
  return groups.sort((a, b) => b.xs.length - a.xs.length);
}

// Detecta las columnas de una página de "Product List" a partir de los valores.
function detectColumns(items) {
  const body = items.filter((i) => !LABELS.test(i.s) && !/^Bandeja:/i.test(i.s));
  const longNums = body.filter((i) => isNum(i.s) && i.s.length >= 7);
  const texts = body.filter((i) => !isNum(i.s));
  const shortNums = body.filter((i) => isNum(i.s) && i.s.length <= 4);
  if (!longNums.length || !texts.length) return null;

  // UPC = columna de números largos más a la DERECHA de las dos (la izquierda es Product_ID).
  const numCols = clusters(longNums.map((i) => i.x)).slice(0, 2).map((g) => g.center).sort((a, b) => a - b);
  const upcX = numCols.at(-1);
  // Descripción y proveedor = las dos columnas de texto con más items, a la derecha del UPC.
  const txtCols = clusters(texts.filter((i) => i.x > upcX).map((i) => i.x), 12).slice(0, 2).map((g) => g.center).sort((a, b) => a - b);
  const [descX, provX] = txtCols;
  // Frentes y unidades = las dos columnas de números cortos a la derecha del proveedor.
  const qtyCols = clusters(shortNums.filter((i) => i.x > (provX ?? descX)).map((i) => i.x)).slice(0, 2).map((g) => g.center).sort((a, b) => a - b);
  const [frentesX, totalX] = qtyCols;
  return { upcX, descX, provX, frentesX, totalX };
}

const near = (x, c, tol) => c != null && Math.abs(x - c) <= tol;

// Lee la "Product List": [{ bandeja, upc, descripcion, proveedor, frentes, unidades, pagina }]
function parseProductList(pages) {
  const productos = [];
  let bandeja = null;
  for (const { n, items } of pages) {
    const cols = detectColumns(items);
    // Encabezados "Bandeja: N" y anclas (UPC) en orden de lectura (de arriba hacia abajo).
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const events = [];
    for (const it of sorted) {
      const m = it.s.match(/^Bandeja:\s*(\d+)/i);
      if (m) events.push({ type: 'bandeja', y: it.y, n: Number(m[1]) });
      else if (cols && isNum(it.s) && it.s.length >= 6 && near(it.x, cols.upcX, 8)) events.push({ type: 'upc', y: it.y, it });
    }
    for (let k = 0; k < events.length; k++) {
      const ev = events[k];
      if (ev.type === 'bandeja') { bandeja = ev.n; continue; }
      // Franja del producto: desde un poco arriba de su UPC hasta antes del siguiente evento.
      const next = events.slice(k + 1).find((e) => e.y < ev.y - 2);
      const top = ev.y + 4;
      const bottom = next ? next.y + 4 : -Infinity;
      const band = items.filter((i) => i.y <= top && i.y > bottom && !LABELS.test(i.s) && !/^Bandeja:/i.test(i.s));
      const byCol = (cx, tol, pred = () => true) => band.filter((i) => near(i.x, cx, tol) && pred(i)).sort((a, b) => b.y - a.y);
      const descripcion = byCol(cols.descX, 14, (i) => !isNum(i.s)).map((i) => i.s).join(' ').trim();
      const proveedor   = byCol(cols.provX, 14, (i) => !isNum(i.s)).map((i) => i.s).join(' ').trim();
      const frentes  = byCol(cols.frentesX, 8, (i) => isNum(i.s))[0];
      const unidades = byCol(cols.totalX, 8, (i) => isNum(i.s))[0];
      productos.push({
        bandeja,
        upc: ev.it.s,
        descripcion,
        proveedor,
        frentes: frentes ? Number(frentes.s) : null,
        unidades: unidades ? Number(unidades.s) : null,
        pagina: n,
      });
    }
  }
  return productos;
}

// Encabezado: títulos de la página 1 (categoría y cadena, ej. "Desodorantes" / "Automercado"),
// fecha dd/mm/aaaa y el nombre del archivo .plnx que repite la página 2. La página 1 viene
// ROTADA (apaisada), así que no se puede confiar en el orden vertical para saber cuál título es
// la categoría y cuál la cadena: se devuelven ambos y el servicio los compara contra lo que el
// usuario eligió en el formulario (solo como advertencia; la tienda/categoría las elige él).
function parseHeader(items1, items2 = []) {
  const fecha = items1.map((i) => i.s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)).find(Boolean);
  const titulos = items1
    .map((i) => i.s)
    .filter((s) => !/^\d/.test(s) && !/^(NOMBRE|FIRMA|AUTORIZACI|GERENTE)/i.test(s) && !/:$/.test(s));
  const archivo = items2.map((i) => i.s).find((s) => /\.plnx$/i.test(s)) ?? null;
  return {
    titulos: [...new Set(titulos)],
    fecha: fecha ? `${fecha[3]}-${fecha[2]}-${fecha[1]}` : null,
    archivo,
  };
}

// Punto de entrada: Buffer del PDF → { header, productos, resumen, advertencias }
async function leerPlanogramaPdf(buffer) {
  const doc = await openPdf(buffer);
  if (doc.numPages < 2) throw Object.assign(new Error('El PDF del planograma debe tener el dibujo (página 1) y la lista de productos (páginas siguientes).'), { statusCode: 400, errorCode: 'ERR_PDF_SIN_LISTA' });

  const pages = [];
  for (let n = 2; n <= doc.numPages; n++) pages.push({ n, items: await pageItems(doc, n) });
  const header = parseHeader(await pageItems(doc, 1), pages[0]?.items);
  const productos = parseProductList(pages);

  const advertencias = [];
  if (!productos.length) advertencias.push('No se encontró ningún producto en la "Product List".');
  const sinBandeja = productos.filter((p) => p.bandeja == null).length;
  if (sinBandeja) advertencias.push(`${sinBandeja} producto(s) sin "Bandeja".`);
  const sinFrentes = productos.filter((p) => p.frentes == null).length;
  if (sinFrentes) advertencias.push(`${sinFrentes} producto(s) sin "Frentes".`);
  const upcs = productos.map((p) => p.upc);
  const repetidos = upcs.filter((u, i) => upcs.indexOf(u) !== i);
  if (repetidos.length) advertencias.push(`UPC repetidos: ${[...new Set(repetidos)].join(', ')}`);

  const bandejas = [...new Set(productos.map((p) => p.bandeja).filter((b) => b != null))].sort((a, b) => a - b);
  return {
    header,
    productos,
    resumen: {
      paginas: doc.numPages,
      productos: productos.length,
      frentes: productos.reduce((s, p) => s + (p.frentes ?? 0), 0),
      bandejas,
    },
    advertencias,
  };
}

module.exports = { leerPlanogramaPdf, parseProductList, detectColumns, parseHeader };
