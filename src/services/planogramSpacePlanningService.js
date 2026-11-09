// Ciclo 5 · B3 (Fase 8) — Lector del formato "SPACE_PLANNING" (Blue Yonder / JDA Space Planning,
// "Front View" impreso a PDF). Muestra: "desodorantes 6x119 prueba.pdf".
//
// Cómo viene este formato (distinto al de Automercado):
//   · UNA página: solo la vista de frente. NO trae lista de productos, ni UPC, ni descripción,
//     ni frentes.
//   · El dibujo es una imagen (raster); encima, como TEXTO, el código de 6 dígitos de cada
//     producto, en la esquina superior izquierda de su bloque. Cuando el bloque es angosto el
//     código se parte en 2 líneas ("4609" / "40" = 460940).
//   · Encabezado: "Planogram: <nombre> - Front View", pie: "File: …\<archivo>.psa", "Printed: dd/mm/aaaa".
//
// Lo que se saca SIN IA (exacto, de la posición del texto):
//   · Filas: los códigos se agrupan por altura → fila 1 = la de ARRIBA (regla del sistema).
//   · Orden: dentro de cada fila, de izquierda a derecha por la x del código.
//   · Caja de cada producto: desde su código hasta el código siguiente de la fila.
//   · Muebles: líneas punteadas verticales del dibujo (separadores de módulo). Si no se
//     encuentran, todo queda en el mueble 1 con una advertencia.
//
// Lo que NO se puede sacar del PDF: el SKU. El código es el código interno de la CADENA, no un
// EAN. Si la empresa cargó el mapeo código → EAN de esa cadena (planogramCodeMapService, CSV),
// se llega al EAN y de ahí al SKU por el mismo camino que el formato con UPC
// (identificarPorCodigo). Sin mapeo, cada posición queda SIN_MATCH / CODIGO_CADENA_SIN_MAPEO /
// REVISAR y el SKU se asigna en la pantalla de revisión.

const sharp = require('sharp');
const drawing = require('./planogramDrawingService');
const { recalcularResumen } = require('./planogramReviewService');

let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

const CODIGO_RE = /^\d+$/;
const LARGO_CODIGO = 6;
const ESCALA_SEPARADORES = 3;

// Texto de la página 1 con posiciones en coordenadas de pantalla (escala 1, origen arriba-izquierda).
async function leerPagina(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    const textos = items.filter((i) => i.str.trim()).map((i) => {
      const h = Math.abs(i.transform[3]) || Math.abs(i.transform[1]) || 1;
      const [x, yBase] = viewport.convertToViewportPoint(i.transform[4], i.transform[5]);
      return { s: i.str.trim(), x, y: yBase - h, h, w: i.width };   // y = borde superior
    });
    // Zona del dibujo = unión de las imágenes de la página.
    const imagenes = await drawing.extraerImagenes(buffer, { scale: 1 });
    return { textos, imagenes, ancho: viewport.width, alto: viewport.height, paginas: doc.numPages };
  } finally {
    await doc.destroy();
  }
}

// Une los códigos partidos en 2 líneas: misma x y mismo tamaño, la 2.ª justo debajo.
function unirCodigos(textos) {
  const nums = textos.filter((t) => CODIGO_RE.test(t.s)).sort((a, b) => a.x - b.x || a.y - b.y);
  const usado = new Set();
  const codigos = [];
  nums.forEach((a, i) => {
    if (usado.has(i)) return;
    usado.add(i);
    let codigo = a.s;
    let ultimo = a;
    for (let j = 0; j < nums.length && codigo.length < LARGO_CODIGO; j++) {
      const b = nums[j];
      if (usado.has(j) || Math.abs(b.x - a.x) > 0.6 || Math.abs(b.h - a.h) > 0.2) continue;
      const dy = b.y - ultimo.y;
      if (dy > 0 && dy < a.h * 1.5) { codigo += b.s; ultimo = b; usado.add(j); j = -1; }
    }
    codigos.push({ codigo, x: a.x, y: a.y, h: a.h, yFin: ultimo.y + ultimo.h });
  });
  return codigos;
}

// Agrupa por altura del código (tolerancia ≈ tamaño de letra) → filas de arriba hacia abajo.
function agruparFilas(codigos) {
  const ordenados = [...codigos].sort((a, b) => a.y - b.y);
  const filas = [];
  for (const c of ordenados) {
    const f = filas.find((r) => Math.abs(r.yRef - c.y) <= Math.max(6, r.hMax * 1.6));
    if (f) { f.items.push(c); f.hMax = Math.max(f.hMax, c.h); } else filas.push({ yRef: c.y, hMax: c.h, items: [c] });
  }
  filas.sort((a, b) => a.yRef - b.yRef);
  filas.forEach((f) => {
    f.items.sort((a, b) => a.x - b.x);
    f.y0 = Math.min(...f.items.map((c) => c.y));
  });
  return filas;
}

// Separadores de módulo = líneas verticales FINAS punteadas dentro de la zona de productos.
// Columna candidata: mucha alternancia oscuro/claro, ~50 % oscura, y mucho más oscura que las
// columnas a 3 px (una línea de 1–2 px, no un producto).
async function detectarSeparadores(buffer, zona) {
  const { png, width: W } = await drawing.renderDibujo(buffer, { scale: ESCALA_SEPARADORES });
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const s = ESCALA_SEPARADORES;
  const y0 = Math.round(zona.y0 * s), y1 = Math.min(info.height, Math.round(zona.y1 * s));
  const x0 = Math.round(zona.x0 * s) + 10, x1 = Math.round(zona.x1 * s) - 10;
  const alto = Math.max(1, y1 - y0);
  const stats = new Array(W).fill(null);
  for (let x = Math.max(0, x0 - 4); x < Math.min(W, x1 + 4); x++) {
    let oscuro = 0, cambios = 0, prev = false;
    for (let y = y0; y < y1; y++) {
      const v = data[y * W + x] < 128;
      if (v) oscuro++;
      if (v !== prev) cambios++;
      prev = v;
    }
    stats[x] = { oscuro: oscuro / alto, cambios };
  }
  const xs = [];
  for (let x = x0; x < x1; x++) {
    const c = stats[x], l = stats[x - 3], r = stats[x + 3];
    if (!c || !l || !r) continue;
    if (c.cambios >= 40 && c.oscuro >= 0.4 && c.oscuro <= 0.75 && c.oscuro - Math.max(l.oscuro, r.oscuro) > 0.2) {
      if (!xs.length || x - xs[xs.length - 1] > 6) xs.push(x);
    }
  }
  return xs.map((x) => x / s);
}

function leerEncabezado(textos) {
  const buscar = (re) => textos.map((t) => t.s.match(re)).find(Boolean);
  const plan = buscar(/^Planogram:\s*(.+?)(?:\s*-\s*Front View)?$/i);
  const archivo = buscar(/^File:\s*(.+)$/i);
  const impreso = buscar(/^Printed:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  return {
    titulos: plan ? [plan[1].trim()] : [],
    archivo: archivo ? archivo[1].trim().split(/[\\/]/).pop() : null,
    fecha: impreso ? `${impreso[3]}-${impreso[2].padStart(2, '0')}-${impreso[1].padStart(2, '0')}` : null,
  };
}

// ¿Es este formato? (lo usa planogramInterpretService.detectarFormato)
function esSpacePlanning(textos) {
  const txt = textos.map((t) => t.s).join(' ');
  const codigos = unirCodigos(textos).filter((c) => c.codigo.length === LARGO_CODIGO);
  return /Front View/i.test(txt) && /Planogram:/i.test(txt) && codigos.length >= 10;
}

// buffer → propuesta (mismo formato que construirPropuestaBase) — sin IA.
// mapeoCodigos: { codigoCadena: ean } (opcional, ver planogramCodeMapService).
async function construirPropuestaSpacePlanning({ buffer, planogramSeq = null, flowDirection = null, pagina = null, mapeoCodigos = null }) {
  const { textos, imagenes, ancho, alto } = pagina ?? await leerPagina(buffer);
  const advertencias = [];
  const header = leerEncabezado(textos);

  // Zona del dibujo: unión de las imágenes grandes (si no hay, toda la página).
  const grandes = imagenes.filter((im) => (im.x1 - im.x0) > ancho * 0.3);
  const zona = grandes.length
    ? { x0: Math.min(...grandes.map((i) => i.x0)), x1: Math.max(...grandes.map((i) => i.x1)), y0: Math.min(...grandes.map((i) => i.y0)), y1: Math.max(...grandes.map((i) => i.y1)) }
    : { x0: 0, x1: ancho, y0: 0, y1: alto };

  const dentro = (c) => c.x >= zona.x0 - 2 && c.x <= zona.x1 && c.y >= zona.y0 - 2 && c.y <= zona.y1;
  const codigos = unirCodigos(textos).filter(dentro);
  const raros = codigos.filter((c) => c.codigo.length !== LARGO_CODIGO);
  if (raros.length) advertencias.push(`${raros.length} código(s) que no tienen ${LARGO_CODIGO} dígitos: ${raros.slice(0, 8).map((c) => c.codigo).join(', ')}${raros.length > 8 ? '…' : ''}`);
  const filas = agruparFilas(codigos);

  let separadores = [];
  try {
    separadores = await detectarSeparadores(buffer, { ...zona, y0: filas[0]?.y0 ?? zona.y0 });
  } catch (e) {
    advertencias.push(`No se pudieron buscar los separadores de módulo (${e.message}).`);
  }
  const limites = [zona.x0, ...separadores, zona.x1];
  const muebleDe = (x) => Math.max(1, limites.findIndex((l, i) => i > 0 && x < l));
  if (!separadores.length) advertencias.push('No se encontraron separadores de módulo (líneas punteadas): todo quedó en el mueble 1. Confirmar en la revisión.');
  advertencias.push('Este formato no trae UPC, descripción ni frentes: el SKU sale del mapeo código de cadena → EAN.');

  const r4 = (v) => +v.toFixed(4);
  const tree = new Map();
  // La última fila no tiene otra debajo: se usa el alto típico de las demás (la zona del dibujo
  // incluye la base negra del mueble).
  const altos = filas.slice(1).map((f, i) => f.y0 - filas[i].y0).sort((a, b) => a - b);
  const altoTipico = altos.length ? altos[Math.floor(altos.length / 2)] : zona.y1 - (filas[0]?.y0 ?? zona.y0);
  filas.forEach((f, iFila) => {
    const yFin = filas[iFila + 1]?.y0 ?? Math.min(zona.y1, f.y0 + altoTipico);
    f.items.forEach((c, k) => {
      const xFin = f.items[k + 1]?.x ?? zona.x1;
      const unit = muebleDe(c.x + 1);
      if (!tree.has(unit)) tree.set(unit, new Map());
      const niveles = tree.get(unit);
      if (!niveles.has(iFila + 1)) niveles.set(iFila + 1, { shelflevel_id: iFila + 1, bandeja: null, orden_fuente: 'PDF_POSICION', orden_estado: 'OK', posiciones: [] });
      const nivel = niveles.get(iFila + 1);
      nivel.posiciones.push({
        shelfcolumn_id: nivel.posiciones.length + 1,
        codigo_cadena: c.codigo,
        ean: null,
        upc: null,
        texto_leido: c.codigo,
        proveedor: null,
        sku_id: null,
        sku_dsc: null,
        match: 'SIN_MATCH',
        match_detalle: 'CODIGO_CADENA_SIN_MAPEO',
        confianza: 0,
        facings: null,
        unidades: null,
        width: null, height: null, depth: null,
        bbox: { x: r4(c.x / ancho), y: r4(c.y / alto), w: r4(Math.max(0, xFin - c.x) / ancho), h: r4(Math.max(0, yFin - c.y) / alto) },
        orden_confianza: 'ALTA',
        estado: 'REVISAR',
      });
    });
  });

  const muebles = [...tree.keys()].sort((a, b) => a - b).map((unit) => ({
    shelfunit_id: unit,
    niveles: [...tree.get(unit).values()].sort((a, b) => a.shelflevel_id - b.shelflevel_id),
  }));
  const todas = muebles.flatMap((m) => m.niveles.flatMap((n) => n.posiciones));
  const repetidos = todas.length - new Set(todas.map((p) => p.codigo_cadena)).size;

  // Mapeo código de cadena → EAN → SKU.
  const mapa = mapeoCodigos && Object.keys(mapeoCodigos).length ? mapeoCodigos : null;
  if (mapa) {
    const { identificarPorCodigo } = require('./planogramProposalService');   // perezoso: usa la BD
    const eans = [...new Set(todas.map((p) => mapa[p.codigo_cadena]).filter(Boolean))];
    const ids = eans.length ? await identificarPorCodigo(eans) : new Map();
    for (const p of todas) {
      const ean = mapa[p.codigo_cadena];
      if (!ean) continue;
      p.upc = ean;
      const hit = ids.get(ean);
      if (hit) {
        Object.assign(p, {
          ean: String(hit.sku.EAN).trim(), sku_id: hit.sku.SKU_ID, sku_dsc: hit.sku.Product_dsc,
          match: 'EAN_EXACTO', match_detalle: 'MAPEO_CADENA', confianza: 1, estado: 'OK',
        });
      } else {
        Object.assign(p, { ean, match_detalle: 'NO_ESTA_EN_CATALOGO' });
      }
    }
    const conEan = todas.filter((p) => p.upc).length;
    const conSku = todas.filter((p) => p.sku_id).length;
    advertencias.push(`Mapeo de códigos de la cadena: ${conEan}/${todas.length} posiciones con EAN, ${conSku} con SKU del catálogo${conEan > conSku ? ` (${conEan - conSku} EAN no están en el catálogo)` : ''}${todas.length > conEan ? `; ${todas.length - conEan} código(s) no están en el mapeo` : ''}.`);
  } else {
    advertencias.push('No hay mapeo de códigos para esta cadena: cargalo en Planogramas → "Códigos de cadena" (CSV codigo,ean) y volvé a interpretar, o asigná los SKU en la revisión.');
  }

  const propuesta = {
    planogram_seq: planogramSeq,
    flow_direction: flowDirection,
    formato: 'SPACE_PLANNING',
    fuente: { tipo: 'PDF', archivo: header.archivo, fecha: header.fecha, titulos: header.titulos },
    regla_bandejas: { muebles: muebles.length, niveles_por_mueble: filas.length, descripcion: 'filas por altura del código (fila 1 = arriba); muebles por líneas punteadas; orden por la x del código' },
    muebles,
    resumen: {
      codigos_repetidos: repetidos,
      orden: { niveles: muebles.reduce((s, m) => s + m.niveles.length, 0), ordenados_ia: 0, por_bloques: 0, a_revisar: 0, confianza: { ALTA: todas.length, MEDIA: 0, BAJA: 0 } },
    },
    advertencias,
  };
  return recalcularResumen(propuesta);
}

module.exports = { construirPropuestaSpacePlanning, esSpacePlanning, leerPagina, unirCodigos, agruparFilas, leerEncabezado };
