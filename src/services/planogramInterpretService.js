// Ciclo 5 · B3 (Fase 8) — Interpretación de un PDF de planograma: detecta el FORMATO y usa el
// lector que corresponde. Cada empresa manda siempre el mismo formato, pero distintas empresas
// usan programas de planimetría distintos; por eso hay un lector por formato y todos entregan la
// MISMA propuesta (muebles → niveles → posiciones), que es lo que consumen la pantalla de
// revisión (8.7) y la aprobación (8.8).
//
//   LISTA_BANDEJAS  (Automercado, .plnx): dibujo + "Product List" con UPC, descripción, frentes y
//                   bandeja. SKU por UPC; orden dentro de la repisa con IA (planogramOrderService).
//   SPACE_PLANNING  (Blue Yonder/JDA, .psa, "Front View"): una página, código de cadena sobre cada
//                   producto. Filas, orden y cajas exactos sin IA; SKU pendiente de mapeo.
//
// Un formato nuevo = un lector nuevo + su regla en detectarFormato().

const { leerPlanogramaPdf } = require('./planogramPdfService');
const { construirPropuestaBase } = require('./planogramProposalService');
const { ordenarPropuesta } = require('./planogramOrderService');
const spacePlanning = require('./planogramSpacePlanningService');
const drawing = require('./planogramDrawingService');
const { recalcularResumen } = require('./planogramReviewService');

let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

const FORMATOS = {
  LISTA_BANDEJAS: 'Lista de productos por bandeja (tipo Automercado, .plnx)',
  SPACE_PLANNING: 'Space Planning — vista de frente con código de cadena (.psa)',
};

function svcError(message, statusCode, errorCode) {
  return Object.assign(new Error(message), { statusCode, errorCode });
}

// Texto de las primeras páginas (para reconocer el formato sin leer todo).
async function textoPaginas(buffer, max = 3) {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
  } catch (e) {
    throw svcError(`El archivo no es un PDF válido (${e.message}).`, 400, 'ERR_PDF_INVALIDO');
  }
  try {
    const out = [];
    for (let i = 1; i <= Math.min(max, doc.numPages); i++) {
      const page = await doc.getPage(i);
      const { items } = await page.getTextContent();
      out.push(items.map((it) => it.str).join(' '));
    }
    return { paginas: doc.numPages, textos: out };
  } finally {
    await doc.destroy();
  }
}

// → 'LISTA_BANDEJAS' | 'SPACE_PLANNING' | null
async function detectarFormato(buffer) {
  const { textos } = await textoPaginas(buffer);
  const todo = textos.join(' ');
  if (/Product List/i.test(todo) && /Bandeja/i.test(todo)) return 'LISTA_BANDEJAS';
  if (/Front View/i.test(textos[0] ?? '') && /Planogram:/i.test(textos[0] ?? '')) {
    const pagina = await spacePlanning.leerPagina(buffer);
    if (spacePlanning.esSpacePlanning(pagina.textos)) return 'SPACE_PLANNING';
  }
  return null;
}

// PDF → { formato, propuesta, dibujoPng }. onRepisa: progreso del orden con IA (solo LISTA_BANDEJAS).
// mapeoCodigos: { codigoCadena: ean } de la empresa + cadena (solo SPACE_PLANNING).
async function interpretarPdf({ buffer, planogramSeq = null, flowDirection = null, onRepisa = null, fetchImpl, env, mapeoCodigos = null }) {
  const formato = await detectarFormato(buffer);
  if (!formato) {
    throw svcError(
      'No se reconoce el formato del PDF. Formatos soportados: ' + Object.values(FORMATOS).join(' · ') + '. Enviá una muestra a DTC para agregar el formato.',
      422, 'ERR_FORMATO_PLANOGRAMA_DESCONOCIDO'
    );
  }

  if (formato === 'SPACE_PLANNING') {
    const propuesta = await spacePlanning.construirPropuestaSpacePlanning({ buffer, planogramSeq, flowDirection, mapeoCodigos });
    const { png, width, height } = await drawing.renderDibujo(buffer);
    propuesta.dibujo = { width, height, escala: 3, muebles: propuesta.muebles.length, niveles: propuesta.regla_bandejas.niveles_por_mueble };
    return { formato, propuesta, dibujoPng: png };
  }

  // LISTA_BANDEJAS
  const pdf = await leerPlanogramaPdf(buffer);
  if (!pdf.productos.length) throw svcError('El PDF no trae productos en la lista.', 422, 'ERR_PLANOGRAMA_SIN_PRODUCTOS');
  const propuesta = await construirPropuestaBase({ pdf, planogramSeq, flowDirection });
  propuesta.formato = formato;
  const opts = { propuesta, pdfBuffer: buffer, onRepisa };
  if (fetchImpl) opts.fetchImpl = fetchImpl;
  if (env) opts.env = env;
  const { dibujoPng } = await ordenarPropuesta(opts);
  recalcularResumen(propuesta);
  return { formato, propuesta, dibujoPng: dibujoPng ?? (await drawing.renderDibujo(buffer)).png };
}

module.exports = { interpretarPdf, detectarFormato, FORMATOS };
