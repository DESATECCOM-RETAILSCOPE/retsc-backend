// Ciclo 5 · B2 — Carga de planogramas (archivo + encabezado en BORRADOR).
// Ciclo 5 · B3 (Fase 8.1/8.6) — el archivo puede ser PDF: al cargarlo se INTERPRETA en segundo
// plano (planogramInterpretService) y la propuesta queda en el blob junto al PDF.
//
// Flujo de createDraft():
//   1. Valida campos (fechas, dirección del pasillo, notas, archivo PDF/JPG/PNG).
//   2. La categoría debe ser una categoría inteligente HABILITADA para la empresa.
//   3. Alcance: UNA tienda (debe existir y pertenecer a la cadena; el Formato se copia de ella) o
//      TODA LA CADENA (retailerId vacío → Retailer_id NULL, Formato NULL). Decisión ciclo 5: la
//      tienda se elige en el formulario (no sale del PDF) y un mismo planograma puede aplicar a
//      todas las tiendas de la cadena (ej. "Automercado cualquiera"). Cambia la regla del plan
//      original ("siempre por tienda individual"); una tienda puede igual tener uno propio.
//   4. Sube la imagen al contenedor enterprise-planograms:
//        {EMPRESA}/{CADENA}/{TIENDA | todas-las-tiendas}/{CATEGORIA}/{yyyyMMdd}_{guid8}.{jpg|png}
//      (nombres legibles, mismo criterio que las fotos de visita; cada segmento cae a su id si
//      el catálogo no tiene descripción).
//   5. Inserta RETSC_OP_PLANOGRAM con Status = 'BORRADOR', Loaded_userid y URL_picture = ruta
//      del blob (relativa al contenedor, no la URL completa: URL_picture es VARCHAR(255)).
//   6. Si es PDF: arranca la interpretación en segundo plano y responde sin esperarla.
//
// Interpretación (8.6) — sin tablas nuevas: el estado y la propuesta viven en el blob, al lado
// del PDF:
//   {ruta}.pdf.propuesta.json  → { estado: PROCESANDO | LISTO | ERROR, …, propuesta }
//   {ruta}.pdf.dibujo.png      → página 1 renderizada (la pantalla de revisión dibuja las cajas)
// Un PROCESANDO de más de INTERPRETACION_MAX_MIN minutos se informa como ERROR (el servidor se
// reinició a mitad); se puede reintentar con reinterpretar().
//
// Revisión (8.7) — guardarRevision(): la pantalla manda los muebles editados; se validan
// (planogramReviewService), se completan los SKU desde el catálogo y se guardan en el mismo JSON.
// La primera vez se conserva la lectura del sistema en `propuesta_original` (para el reporte de
// precisión, B5). Aprobación (8.8) — aprobar(): transacción en planogramRepo.aprobarPlanograma.

const crypto = require('crypto');
const planogramRepo          = require('../repositories/planogramRepo');
const retailerRepo           = require('../repositories/retailerRepo');
const enterpriseRepo         = require('../repositories/enterpriseRepo');
const enterpriseCategoryRepo = require('../repositories/enterpriseCategoryRepo');
const blobStorageService     = require('./blobStorageService');
const skuRepo                = require('../repositories/skuRepo');
const review                 = require('./planogramReviewService');
const codeMap                = require('./planogramCodeMapService');
const { stripZeros, lookupCandidates, dbVariants } = require('../utils/gtin');

const PLANOGRAM_CONTAINER = () => process.env.AZURE_PLANOGRAM_CONTAINER || 'enterprise-planograms';
const FLOW_DIRECTIONS = ['IZQ_DER', 'DER_IZQ'];
const FORMATO_MAX = 30;   // RETSC_OP_PLANOGRAM.Formato VARCHAR(30) (ver migrations/020 paso 3)
const NOTES_MAX   = 255;
const FILE_TYPES  = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
const INTERPRETACION_MAX_MIN = 10;
const sufijoPropuesta = (blobPath) => `${blobPath}.propuesta.json`;
const sufijoDibujo    = (blobPath) => `${blobPath}.dibujo.png`;
const esPdf = (blobPath) => /\.pdf$/i.test(blobPath || '');
const TODAS_LAS_TIENDAS_FOLDER = 'todas-las-tiendas';

function svcError(message, statusCode, errorCode) {
  return Object.assign(new Error(message), { statusCode, errorCode });
}

// Segmento de ruta legible: sin tildes ni símbolos, máx. 40 caracteres.
function pathSegment(description, fallback) {
  if (!description) return fallback;
  const clean = String(description)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return clean || fallback;
}

// 'yyyy-mm-dd' válido → string; vacío → null; inválido → lanza.
function parseDate(value, label, { required = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) throw svcError(`${label} es requerida.`, 400, 'ERR_FECHA_REQUERIDA');
    return null;
  }
  const s = String(value).trim();
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw svcError(`${label} no es una fecha válida (formato yyyy-mm-dd).`, 400, 'ERR_FECHA_INVALIDA');
  }
  return s;
}

function parseIntField(value, label) {
  const n = parseInt(value, 10);
  if (!n || Number.isNaN(n)) throw svcError(`${label} es requerido.`, 400, 'ERR_CAMPO_REQUERIDO');
  return n;
}

async function createDraft({
  enterpriseId, userId, categoryId, supermarketchainId, retailerId,
  upDate, downDate, flowDirection, notes, buffer, mimetype,
}) {
  // ── 1. Validaciones de campos ──────────────────────────────────────────────
  if (!enterpriseId) throw svcError('La sesión no tiene empresa asociada.', 400, 'ERR_SIN_EMPRESA');
  const catId    = parseIntField(categoryId, 'La categoría');
  const chainId  = parseIntField(supermarketchainId, 'La cadena');
  // Tienda opcional: vacío / null / 'TODAS' = toda la cadena.
  const storeRaw = retailerId == null ? '' : String(retailerId).trim();
  const storeId  = storeRaw === '' || storeRaw.toUpperCase() === 'TODAS' ? null : parseIntField(storeRaw, 'La tienda');
  const desde    = parseDate(upDate, 'La vigencia desde', { required: true });
  const hasta    = parseDate(downDate, 'La vigencia hasta');
  if (hasta && hasta < desde) {
    throw svcError('La vigencia "hasta" no puede ser anterior a "desde".', 400, 'ERR_VIGENCIA_INVALIDA');
  }
  if (!FLOW_DIRECTIONS.includes(flowDirection)) {
    throw svcError('La dirección del pasillo debe ser IZQ_DER o DER_IZQ.', 400, 'ERR_DIRECCION_INVALIDA');
  }
  const notas = notes ? String(notes).trim() : null;
  if (notas && notas.length > NOTES_MAX) {
    throw svcError(`Las notas no pueden pasar de ${NOTES_MAX} caracteres.`, 400, 'ERR_NOTAS_DEMASIADO_LARGAS');
  }
  if (!buffer?.length) throw svcError('Se requiere el archivo del planograma.', 400, 'ERR_ARCHIVO_REQUERIDO');
  const ext = FILE_TYPES[String(mimetype || '').toLowerCase()];
  if (!ext) throw svcError('El planograma debe ser un PDF (o una imagen JPG/PNG).', 400, 'ERR_FORMATO_NO_SOPORTADO');
  if (ext === 'pdf' && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw svcError('El archivo no es un PDF válido.', 400, 'ERR_PDF_INVALIDO');
  }

  // ── 2. Categoría habilitada para la empresa ─────────────────────────────────
  const categorias = await enterpriseCategoryRepo.listSmartForEnterprise(enterpriseId);
  const categoria  = categorias.find(c => Number(c.category_id) === catId);
  if (!categoria) {
    throw svcError('La categoría no está habilitada para tu empresa.', 400, 'ERR_CATEGORIA_NO_HABILITADA');
  }

  // ── 3. Alcance: una tienda de la cadena (+ formato) o toda la cadena ────────
  const [tienda, cadena, empresa] = await Promise.all([
    storeId ? retailerRepo.findById(storeId) : Promise.resolve(null),
    planogramRepo.findChainById(chainId),
    enterpriseRepo.findById(enterpriseId),
  ]);
  if (!cadena) throw svcError('La cadena no existe.', 400, 'ERR_CADENA_NO_EXISTE');
  if (storeId) {
    if (!tienda) throw svcError('La tienda no existe.', 400, 'ERR_TIENDA_NO_EXISTE');
    if (Number(tienda.Supermarketchain_id) !== chainId) {
      throw svcError('La tienda no pertenece a la cadena seleccionada.', 400, 'ERR_TIENDA_NO_ES_DE_LA_CADENA');
    }
  }
  const formato = tienda?.Formato ?? null;   // toda la cadena → sin formato
  if (formato && formato.length > FORMATO_MAX) {
    throw svcError(
      `El formato de la tienda ("${formato}") mide ${formato.length} caracteres y la columna admite ${FORMATO_MAX}. Hay que ampliar RETSC_OP_PLANOGRAM.Formato (migración 020, paso 3).`,
      400, 'ERR_FORMATO_DEMASIADO_LARGO'
    );
  }

  // ── 4. Archivo al blob ──────────────────────────────────────────────────────
  const now   = new Date();
  const fecha = now.toISOString().slice(0, 10).replace(/-/g, '');
  const blobPath = [
    pathSegment(empresa?.Enterprise_dsc, `enterprise-${enterpriseId}`),
    pathSegment(cadena.Supermarketchain, `cadena-${chainId}`),
    storeId ? pathSegment(tienda.Retailer_dsc, `tienda-${storeId}`) : TODAS_LAS_TIENDAS_FOLDER,
    pathSegment(categoria.category_dsc,  `categoria-${catId}`),
    `${fecha}_${crypto.randomUUID().slice(0, 8)}.${ext}`,
  ].join('/');

  await blobStorageService.ensureContainerExists(PLANOGRAM_CONTAINER());
  const upload = await blobStorageService.uploadToContainer({
    containerName: PLANOGRAM_CONTAINER(),
    blobPath,
    buffer,
    contentType: CONTENT_TYPES[ext],
  });
  console.log(`[planogram] archivo subido — ${PLANOGRAM_CONTAINER()}/${blobPath} (mode=${upload.mode})`);

  // ── 5. Encabezado en BORRADOR ───────────────────────────────────────────────
  let seq;
  try {
    seq = await planogramRepo.insertDraft({
      enterpriseId, categoryId: catId, supermarketchainId: chainId, retailerId: storeId, formato,
      upDate: desde, downDate: hasta, flowDirection, notes: notas, loadedUserId: userId,
      urlPicture: blobPath,
    });
  } catch (err) {
    // La imagen ya quedó en el blob: se loguea la ruta para poder limpiarla a mano.
    console.error(`[planogram] falló el INSERT tras subir la imagen (queda huérfana: ${PLANOGRAM_CONTAINER()}/${blobPath}):`, err.message);
    if (/Flow_direction/i.test(err.message)) {
      throw svcError('Falta la columna Flow_direction en RETSC_OP_PLANOGRAM — correr migrations/020_planogram_flow_direction.sql.', 500, 'ERR_FALTA_MIGRACION_020');
    }
    throw err;
  }
  console.log(`[planogram] planograma ${seq} creado en BORRADOR — empresa=${enterpriseId} ${storeId ? `tienda=${storeId}` : `toda la cadena=${chainId}`} categoría=${catId}`);

  // ── 6. PDF → interpretación en segundo plano ────────────────────────────────
  // Si no arranca (ej. falla el blob), el planograma igual queda creado: la pantalla ofrece
  // "Interpretar" (estado SIN_INTERPRETAR).
  if (ext === 'pdf') {
    await iniciarInterpretacion({ seq, blobPath, flowDirection, buffer, enterpriseId, chainId })
      .catch((err) => console.error(`[planogram] ${seq} — no se pudo iniciar la interpretación:`, err.message));
  }

  return planogramRepo.findBySeq(seq, enterpriseId);
}

// ── Interpretación (8.6) ─────────────────────────────────────────────────────
const enCurso = new Set();

const guardarJson = (blobPath, data) => blobStorageService.uploadToContainer({
  containerName: PLANOGRAM_CONTAINER(), blobPath: sufijoPropuesta(blobPath),
  buffer: Buffer.from(JSON.stringify(data)), contentType: 'application/json',
});

const noEncontrado = (err) => err?.code === 'ENOENT' || err?.statusCode === 404 || err?.details?.errorCode === 'BlobNotFound';

// Marca PROCESANDO (await) y corre la interpretación sin bloquear la respuesta HTTP.
// `correr` se expone para las pruebas (corre en primer plano).
async function iniciarInterpretacion({ seq, blobPath, flowDirection, buffer, enterpriseId = null, chainId = null }, { enPrimerPlano = false } = {}) {
  if (enCurso.has(seq)) throw svcError(`El planograma ${seq} ya se está interpretando.`, 409, 'ERR_INTERPRETACION_EN_CURSO');
  enCurso.add(seq);
  try {
    await guardarJson(blobPath, { estado: 'PROCESANDO', inicio: new Date().toISOString() });
  } catch (err) {
    enCurso.delete(seq);
    throw err;
  }
  const tarea = correrInterpretacion({ seq, blobPath, flowDirection, buffer, enterpriseId, chainId }).finally(() => enCurso.delete(seq));
  if (enPrimerPlano) return tarea;
  tarea.catch(() => {});   // los errores ya quedan guardados en el JSON
  return undefined;
}

async function correrInterpretacion({ seq, blobPath, flowDirection, buffer, enterpriseId, chainId }) {
  const t0 = Date.now();
  const inicio = new Date(t0).toISOString();
  try {
    const { interpretarPdf } = require('./planogramInterpretService');   // perezoso: pdfjs/sharp solo si hay PDFs
    const mapeo = await codeMap.leerMapeo(enterpriseId, chainId).catch((e) => {
      console.error(`[planogram] ${seq} — no se pudo leer el mapeo de códigos de la cadena:`, e.message);
      return null;
    });
    const { formato, propuesta, dibujoPng } = await interpretarPdf({ buffer, planogramSeq: seq, flowDirection, mapeoCodigos: mapeo?.codigos ?? null });
    review.asignarPosIds(propuesta);
    await blobStorageService.uploadToContainer({
      containerName: PLANOGRAM_CONTAINER(), blobPath: sufijoDibujo(blobPath), buffer: dibujoPng, contentType: 'image/png',
    });
    const duracion = +((Date.now() - t0) / 1000).toFixed(1);
    await guardarJson(blobPath, { estado: 'LISTO', formato, inicio, fin: new Date().toISOString(), duracion_s: duracion, propuesta });
    console.log(`[planogram] ${seq} interpretado (${formato}) en ${duracion} s — ${propuesta.resumen.posiciones} posiciones`);
  } catch (err) {
    console.error(`[planogram] ${seq} — falló la interpretación:`, err.message);
    await guardarJson(blobPath, {
      estado: 'ERROR', inicio, fin: new Date().toISOString(),
      errorCode: err.errorCode || 'ERR_INTERPRETACION', mensaje: err.message,
    }).catch((e) => console.error(`[planogram] ${seq} — tampoco se pudo guardar el error:`, e.message));
  }
}

// GET propuesta → { estado, formato?, propuesta?, errorCode?, mensaje?, inicio?, fin?, duracion_s? }
async function getPropuesta(seq, enterpriseId) {
  const p = await planogramRepo.findBySeq(seq, enterpriseId);
  if (!p) throw svcError(`Planograma ${seq} no encontrado.`, 404, 'ERR_NO_ENCONTRADO');
  if (!esPdf(p.URL_picture)) return { estado: 'NO_APLICA', mensaje: 'El planograma se cargó como imagen: la lectura automática es solo para PDF.' };
  let doc;
  try {
    const buf = await blobStorageService.downloadFromContainer({ containerName: PLANOGRAM_CONTAINER(), blobPath: sufijoPropuesta(p.URL_picture) });
    doc = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    if (noEncontrado(err)) return { estado: 'SIN_INTERPRETAR' };
    throw err;
  }
  if (doc.estado === 'PROCESANDO' && !enCurso.has(seq) && Date.now() - Date.parse(doc.inicio) > INTERPRETACION_MAX_MIN * 60_000) {
    return { estado: 'ERROR', errorCode: 'ERR_INTERPRETACION_INTERRUMPIDA', mensaje: 'La interpretación se interrumpió (el servidor se reinició). Volvé a interpretar.', inicio: doc.inicio };
  }
  if (doc.propuesta) review.asignarPosIds(doc.propuesta);   // propuestas leídas antes de existir pos_id
  if (doc.propuesta && doc.propuesta_original) doc.precision = review.calcularPrecision(doc.propuesta_original, doc.propuesta);
  return { ...doc, planogramStatus: p.Status };
}

async function leerDocRevisable(seq, enterpriseId) {
  const p = await planogramRepo.findBySeq(seq, enterpriseId);
  if (!p) throw svcError(`Planograma ${seq} no encontrado.`, 404, 'ERR_NO_ENCONTRADO');
  if (!esPdf(p.URL_picture)) throw svcError('Solo se revisan planogramas cargados en PDF.', 400, 'ERR_NO_ES_PDF');
  const doc = await getPropuesta(seq, enterpriseId);
  if (doc.estado !== 'LISTO' || !doc.propuesta) throw svcError('El planograma todavía no tiene una lectura lista para revisar.', 409, 'ERR_PROPUESTA_NO_LISTA');
  delete doc.precision;
  delete doc.planogramStatus;
  delete doc.success;
  return { p, doc };
}

// PUT propuesta (8.7) → guarda la revisión. body: { muebles: [...] }
async function guardarRevision(seq, enterpriseId, userId, { muebles } = {}) {
  const { p, doc } = await leerDocRevisable(seq, enterpriseId);
  if (p.Status !== 'BORRADOR') throw svcError('Solo se puede editar un planograma en borrador.', 409, 'ERR_NO_ES_BORRADOR');
  const ids = (muebles ?? []).flatMap((m) => (m?.niveles ?? []).flatMap((n) => (n?.posiciones ?? []).map((x) => Number(x?.sku_id)).filter(Boolean)));
  const catalogo = new Map((await skuRepo.findSkusByIds(ids)).map((s) => [Number(s.SKU_ID), s]));
  const nuevos = review.normalizarEdicion(muebles, { original: doc.propuesta, catalogo });
  if (!doc.propuesta_original) doc.propuesta_original = JSON.parse(JSON.stringify(doc.propuesta));
  doc.propuesta.muebles = nuevos;
  review.recalcularResumen(doc.propuesta);
  doc.revision = { usuario: userId ?? null, fecha: new Date().toISOString(), guardados: (doc.revision?.guardados ?? 0) + 1 };
  await guardarJson(p.URL_picture, doc);
  return getPropuesta(seq, enterpriseId);
}

// POST aprobar (8.8) → graba el detalle y activa el planograma (inactiva el anterior del mismo alcance).
async function aprobar(seq, enterpriseId, userId) {
  const { p, doc } = await leerDocRevisable(seq, enterpriseId);
  if (p.Status !== 'BORRADOR') throw svcError(`El planograma ${seq} ya no está en borrador (${p.Status}).`, 409, 'ERR_NO_ES_BORRADOR');
  const filas = review.filasParaAprobar(doc.propuesta);
  // Los SKU tienen que seguir existiendo (FK de RETSC_OP_PLANOGRAMDET).
  const existentes = new Set((await skuRepo.findSkusByIds(filas.map((f) => f.sku_id))).map((s) => Number(s.SKU_ID)));
  const faltan = [...new Set(filas.map((f) => f.sku_id).filter((id) => !existentes.has(Number(id))))];
  if (faltan.length) throw svcError(`Estos SKU ya no existen en el catálogo: ${faltan.join(', ')}.`, 409, 'ERR_SKU_NO_EXISTE');

  const r = await planogramRepo.aprobarPlanograma({ seq, enterpriseId, filas });
  console.log(`[planogram] ${seq} APROBADO — ${r.filas} posiciones; inactivados: ${r.inactivados.map((x) => x.Planogram_seq).join(', ') || 'ninguno'}`);
  if (!doc.propuesta_original) doc.propuesta_original = JSON.parse(JSON.stringify(doc.propuesta));
  doc.aprobacion = { usuario: userId ?? null, fecha: new Date().toISOString(), filas: r.filas, inactivados: r.inactivados };
  await guardarJson(p.URL_picture, doc).catch((e) => console.error(`[planogram] ${seq} — aprobado, pero no se pudo guardar la marca en el JSON:`, e.message));
  return { ...r, planogram: await planogramRepo.findBySeq(seq, enterpriseId) };
}

// GET skus?q= → buscador de la revisión (por EAN o por descripción).
async function buscarSkus(q, { limit = 20 } = {}) {
  const texto = String(q ?? '').trim();
  if (texto.length < 2) return [];
  const digits = texto.replace(/\D/g, '');
  if (/^\d+$/.test(texto.replace(/\s/g, '')) && digits.length >= 4) {
    const eanVariants = digits.length >= 7
      ? [...new Set(lookupCandidates(digits).flatMap((c) => dbVariants(c.key)))]
      : [];
    const rows = await skuRepo.searchSkus({ eanVariants, digits, limit });
    const exactos = new Set(lookupCandidates(digits).map((c) => c.key));
    return rows.sort((a, b) => Number(exactos.has(stripZeros(b.EAN))) - Number(exactos.has(stripZeros(a.EAN))));
  }
  const words = texto.split(/\s+/).filter((w) => w.length >= 2).slice(0, 5);
  return skuRepo.searchSkus({ words, limit });
}

// Mapeo de códigos de cadena (formato SPACE_PLANNING).
async function getMapeoCodigos(enterpriseId, chainId) {
  if (!Number(chainId)) throw svcError('La cadena es requerida.', 400, 'ERR_CAMPO_REQUERIDO');
  return codeMap.resumenMapeo(enterpriseId, chainId);
}
async function cargarMapeoCodigos({ enterpriseId, userId, supermarketchainId, buffer, nombreArchivo }) {
  const cadena = await planogramRepo.findChainById(Number(supermarketchainId));
  if (!cadena) throw svcError('La cadena no existe.', 400, 'ERR_CADENA_NO_EXISTE');
  return codeMap.guardarMapeo({ enterpriseId, chainId: Number(supermarketchainId), buffer, nombreArchivo, userId });
}

// POST interpretar → vuelve a interpretar un PDF en BORRADOR (no espera el resultado).
async function reinterpretar(seq, enterpriseId) {
  const p = await planogramRepo.findBySeq(seq, enterpriseId);
  if (!p) throw svcError(`Planograma ${seq} no encontrado.`, 404, 'ERR_NO_ENCONTRADO');
  if (!esPdf(p.URL_picture)) throw svcError('Solo se interpretan planogramas cargados en PDF.', 400, 'ERR_NO_ES_PDF');
  if (p.Status !== 'BORRADOR') throw svcError('Solo se puede volver a interpretar un planograma en borrador.', 409, 'ERR_NO_ES_BORRADOR');
  const actual = await getPropuesta(seq, enterpriseId);
  if (actual.estado === 'PROCESANDO') throw svcError(`El planograma ${seq} ya se está interpretando.`, 409, 'ERR_INTERPRETACION_EN_CURSO');
  const buffer = await blobStorageService.downloadFromContainer({ containerName: PLANOGRAM_CONTAINER(), blobPath: p.URL_picture });
  // Volver a interpretar descarta la revisión guardada (se avisa en la pantalla).
  await iniciarInterpretacion({ seq, blobPath: p.URL_picture, flowDirection: p.Flow_direction, buffer, enterpriseId, chainId: p.Supermarketchain_id });
  return { estado: 'PROCESANDO' };
}

async function getDibujo(seq, enterpriseId) {
  const p = await planogramRepo.findBySeq(seq, enterpriseId);
  if (!p || !esPdf(p.URL_picture)) throw svcError(`El planograma ${seq} no tiene dibujo interpretado.`, 404, 'ERR_NO_ENCONTRADO');
  try {
    return await blobStorageService.downloadFromContainer({ containerName: PLANOGRAM_CONTAINER(), blobPath: sufijoDibujo(p.URL_picture) });
  } catch (err) {
    if (noEncontrado(err)) throw svcError('El dibujo todavía no está listo.', 404, 'ERR_NO_ENCONTRADO');
    throw err;
  }
}

async function getCatalogs() {
  const [chains, retailers] = await Promise.all([planogramRepo.listChains(), retailerRepo.list()]);
  return {
    chains: chains.map(c => ({ supermarketchainId: c.Supermarketchain_id, name: c.Supermarketchain })),
    retailers: retailers.map(r => ({
      retailerId: r.Retailer_id, name: r.Retailer_dsc,
      supermarketchainId: r.Supermarketchain_id, formato: r.Formato,
    })),
  };
}

async function getImage(seq, enterpriseId) {
  const p = await planogramRepo.findBySeq(seq, enterpriseId);
  if (!p?.URL_picture) throw svcError(`Planograma ${seq} no encontrado.`, 404, 'ERR_NO_ENCONTRADO');
  const buffer = await blobStorageService.downloadFromContainer({ containerName: PLANOGRAM_CONTAINER(), blobPath: p.URL_picture });
  const ext = p.URL_picture.toLowerCase().split('.').pop();
  return { buffer, contentType: CONTENT_TYPES[ext === 'jpeg' ? 'jpg' : ext] ?? 'application/octet-stream' };
}

module.exports = {
  createDraft, getCatalogs, getImage, getPropuesta, reinterpretar, getDibujo,
  guardarRevision, aprobar, buscarSkus, getMapeoCodigos, cargarMapeoCodigos,
  iniciarInterpretacion, pathSegment, FLOW_DIRECTIONS,
};
