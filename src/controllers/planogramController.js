// Ciclo 5 · B2 — Controller de planogramas. Rutas: /api/planograms (ver planogramRoutes.js).
// La empresa SIEMPRE sale de la sesión (req.user.enterpriseId), nunca del body.

const fs               = require('fs').promises;
const planogramService = require('../services/planogramService');
const planogramRepo    = require('../repositories/planogramRepo');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[planogram]', err);
  return res.status(status).json({ success: false, message: err.message, ...(err.errorCode && { errorCode: err.errorCode }) });
}

const parseSeq = (v) => {
  const n = parseInt(v, 10);
  if (!n) throw Object.assign(new Error('Planogram_seq inválido.'), { statusCode: 400 });
  return n;
};

// GET /api/planograms/catalogos — cadenas y tiendas para el formulario de carga.
const getCatalogs = async (_req, res) => {
  try {
    return res.json({ success: true, ...(await planogramService.getCatalogs()) });
  } catch (err) { return handleError(res, err); }
};

// GET /api/planograms?status=&categoryId=&retailerId=
const list = async (req, res) => {
  try {
    const { status, categoryId, retailerId } = req.query;
    const planograms = await planogramRepo.listByEnterprise(req.user.enterpriseId, {
      status: status || null,
      categoryId: categoryId ? parseInt(categoryId, 10) : null,
      retailerId: retailerId ? parseInt(retailerId, 10) : null,
    });
    return res.json({ success: true, planograms });
  } catch (err) { return handleError(res, err); }
};

// GET /api/planograms/:seq
const getOne = async (req, res) => {
  try {
    const p = await planogramRepo.findBySeq(parseSeq(req.params.seq), req.user.enterpriseId);
    if (!p) return res.status(404).json({ success: false, message: 'Planograma no encontrado.' });
    return res.json({ success: true, planogram: p });
  } catch (err) { return handleError(res, err); }
};

// GET /api/planograms/:seq/image — bytes de la imagen (contenedor privado → proxy, no SAS).
const getImage = async (req, res) => {
  try {
    const { buffer, contentType } = await planogramService.getImage(parseSeq(req.params.seq), req.user.enterpriseId);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(buffer);
  } catch (err) {
    if (err.code === 'ENOENT' || err.details?.errorCode === 'BlobNotFound') {
      return res.status(404).json({ success: false, message: 'El archivo del planograma no está en el almacenamiento.' });
    }
    return handleError(res, err);
  }
};

// GET /api/planograms/:seq/propuesta — estado + propuesta de la interpretación (Fase 8).
const getPropuesta = async (req, res) => {
  try {
    const doc = await planogramService.getPropuesta(parseSeq(req.params.seq), req.user.enterpriseId);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...doc });
  } catch (err) { return handleError(res, err); }
};

// GET /api/planograms/:seq/dibujo — PNG de la página 1 (las cajas de la propuesta son relativas a él).
const getDibujo = async (req, res) => {
  try {
    const buffer = await planogramService.getDibujo(parseSeq(req.params.seq), req.user.enterpriseId);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(buffer);
  } catch (err) { return handleError(res, err); }
};

// POST /api/planograms/:seq/interpretar — vuelve a interpretar el PDF (202, sin esperar).
const reinterpretar = async (req, res) => {
  try {
    const r = await planogramService.reinterpretar(parseSeq(req.params.seq), req.user.enterpriseId);
    return res.status(202).json({ success: true, ...r });
  } catch (err) { return handleError(res, err); }
};

// PUT /api/planograms/:seq/propuesta — guarda la revisión (8.7). body: { muebles }
const guardarRevision = async (req, res) => {
  try {
    const doc = await planogramService.guardarRevision(parseSeq(req.params.seq), req.user.enterpriseId, req.user.userId, req.body ?? {});
    return res.json({ success: true, ...doc });
  } catch (err) { return handleError(res, err); }
};

// POST /api/planograms/:seq/aprobar — graba el detalle y activa (8.8).
const aprobar = async (req, res) => {
  try {
    const r = await planogramService.aprobar(parseSeq(req.params.seq), req.user.enterpriseId, req.user.userId);
    return res.json({ success: true, ...r });
  } catch (err) {
    if (err.pendientes) return res.status(err.statusCode || 409).json({ success: false, errorCode: err.errorCode, message: err.message, pendientes: err.pendientes });
    return handleError(res, err);
  }
};

// GET /api/planograms/:seq/detalle — filas grabadas en RETSC_OP_PLANOGRAMDET (planograma aprobado).
const getDetalle = async (req, res) => {
  try {
    const seq = parseSeq(req.params.seq);
    const p = await planogramRepo.findBySeq(seq, req.user.enterpriseId);
    if (!p) return res.status(404).json({ success: false, message: 'Planograma no encontrado.' });
    return res.json({ success: true, detalle: await planogramRepo.listDetail(seq) });
  } catch (err) { return handleError(res, err); }
};

// GET /api/planograms/skus?q= — buscador de SKU de la revisión.
const buscarSkus = async (req, res) => {
  try {
    return res.json({ success: true, skus: await planogramService.buscarSkus(req.query.q, { limit: req.query.limit }) });
  } catch (err) { return handleError(res, err); }
};

// GET /api/planograms/codigos-cadena?supermarketchainId= — resumen del mapeo de la empresa.
const getMapeoCodigos = async (req, res) => {
  try {
    return res.json({ success: true, ...(await planogramService.getMapeoCodigos(req.user.enterpriseId, req.query.supermarketchainId)) });
  } catch (err) { return handleError(res, err); }
};

// POST /api/planograms/codigos-cadena — multipart: "archivo" (CSV codigo,ean) + supermarketchainId.
const cargarMapeoCodigos = async (req, res) => {
  const filePath = req.file?.path ?? null;
  try {
    if (!req.file) return res.status(400).json({ success: false, errorCode: 'ERR_ARCHIVO_REQUERIDO', message: 'Se requiere el campo "archivo" con el CSV (codigo,ean).' });
    const r = await planogramService.cargarMapeoCodigos({
      enterpriseId: req.user.enterpriseId,
      userId: req.user.userId,
      supermarketchainId: req.body?.supermarketchainId,
      buffer: await fs.readFile(req.file.path),
      nombreArchivo: req.file.originalname,
    });
    return res.json({ success: true, ...r });
  } catch (err) {
    if (err.errores) return res.status(err.statusCode || 400).json({ success: false, errorCode: err.errorCode, message: err.message, errores: err.errores });
    return handleError(res, err);
  } finally {
    if (filePath) await fs.unlink(filePath).catch(() => {});
  }
};

// POST /api/planograms — multipart: archivo "image" + categoryId, supermarketchainId,
// retailerId, upDate, downDate?, flowDirection, notes?
const create = async (req, res) => {
  const filePath = req.file?.path ?? null;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, errorCode: 'ERR_ARCHIVO_REQUERIDO', message: 'Se requiere el campo "image" con el archivo del planograma (PDF, JPG o PNG, máx. 15 MB).' });
    }
    const buffer = await fs.readFile(req.file.path);
    const planogram = await planogramService.createDraft({
      ...req.body,
      enterpriseId: req.user.enterpriseId,
      userId: req.user.userId,
      buffer,
      // Algunos navegadores mandan los PDF como application/octet-stream: manda la extensión.
      mimetype: /\.pdf$/i.test(req.file.originalname || '') ? 'application/pdf' : req.file.mimetype,
    });
    return res.status(201).json({ success: true, planogram });
  } catch (err) {
    return handleError(res, err);
  } finally {
    if (filePath) await fs.unlink(filePath).catch(() => {});
  }
};

module.exports = {
  getCatalogs, list, getOne, getImage, getPropuesta, getDibujo, reinterpretar, create,
  guardarRevision, aprobar, getDetalle, buscarSkus, getMapeoCodigos, cargarMapeoCodigos,
};
