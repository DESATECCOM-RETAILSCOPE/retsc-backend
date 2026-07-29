const crypto           = require('crypto');
const fs               = require('fs').promises;
const path             = require('path');
const excelService     = require('../services/excelService');
const productService   = require('../services/productService');
const pipelineOrch     = require('../services/pipelineOrchestrator');
const loadStateRepo    = require('../repositories/loadStateRepo');
const { extractGTINFromFilename } = require('../services/matchingService');

const UPLOADS_TEMP = path.join(__dirname, '..', '..', 'uploads-temp');

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[product]', err);
  return res.status(status).json({ success: false, message: err.message });
}

function now() { return new Date().toISOString(); }

// ── 10.1 POST /api/products/upload-excel ─────────────────────────────────────
const uploadExcel = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Se requiere un archivo Excel (.xlsx o .xls)' });

    const parsed = await excelService.parseExcel(req.file.path);
    const validation = await excelService.validateStructure(parsed);

    // Limpiar el Excel temporal ya que los datos quedan en el job
    await fs.unlink(req.file.path).catch(() => {});

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: 'Estructura del Excel inválida',
        errors: validation.structuralErrors,
      });
    }

    const jobId = crypto.randomUUID();
    const ts = now();

    await loadStateRepo.insert({
      Job_id:        jobId,
      Enterprise_id: req.user.enterpriseId,
      Status:        'uploaded_excel',
      Current_step:  null,
      Created_date:  ts,
      Updated_date:  ts,
      Excel_data:    parsed.rows,
      Image_files:   [],
      Metrics: {
        totalRows:           parsed.rows.length,
        validGtins:          0,
        invalidGtins:        [],
        totalImages:         0,
        duplicateImages:     [],
        unmatchedImages:     [],
        productsWithoutImage: [],
        uploaded:            0,
        inserted:            0,
      },
      Error_message: null,
    });

    return res.status(201).json({
      success:          true,
      jobId,
      totalRows:        parsed.rows.length,
      structuralErrors: validation.structuralErrors,
      rowErrors:        parsed.errors.filter(e => !validation.structuralErrors.includes(e)),
    });
  } catch (err) { return handleError(res, err); }
};

// ── 10.2 POST /api/products/upload-images ────────────────────────────────────
const uploadImages = async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ success: false, message: 'jobId es requerido' });

    const job = await loadStateRepo.findById(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job no encontrado' });
    if (job.Enterprise_id !== req.user.enterpriseId) {
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'Se requiere al menos un archivo de imagen' });
    }

    // Mover archivos del directorio temporal de multer al directorio del job
    const jobDir = path.join(UPLOADS_TEMP, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const imageFiles = [];
    const invalidFilenames = [];

    for (const file of req.files) {
      const destPath = path.join(jobDir, file.originalname);
      await fs.rename(file.path, destPath).catch(async () => {
        // rename puede fallar cross-device; copiar y borrar
        await fs.copyFile(file.path, destPath);
        await fs.unlink(file.path).catch(() => {});
      });

      const gtin = extractGTINFromFilename(file.originalname);
      if (!gtin) invalidFilenames.push(file.originalname);
      imageFiles.push({ originalName: file.originalname, tempPath: destPath, gtinExtracted: gtin });
    }

    // Limpiar directorio temporal de multer si quedó vacío
    if (req.files[0]?.destination) {
      await fs.rmdir(req.files[0].destination).catch(() => {});
    }

    await loadStateRepo.update(jobId, {
      Status:      'uploaded_images',
      Image_files: imageFiles,
      Updated_date: now(),
    });

    return res.json({ success: true, jobId, totalImages: imageFiles.length, invalidFilenames });
  } catch (err) { return handleError(res, err); }
};

// ── 10.3 POST /api/products/process/:jobId ───────────────────────────────────
const processJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await loadStateRepo.findById(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job no encontrado' });
    if (job.Enterprise_id !== req.user.enterpriseId) {
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }
    if (job.Status !== 'uploaded_images') {
      return res.status(400).json({
        success: false,
        message: `El job debe estar en estado 'uploaded_images' (actual: '${job.Status}')`,
      });
    }

    const result = await pipelineOrch.executePipeline(jobId);
    return res.json({
      success:  result.Status === 'completed',
      jobId,
      status:   result.Status,
      metrics:  result.Metrics,
      error:    result.Error_message ?? undefined,
    });
  } catch (err) { return handleError(res, err); }
};

// ── 10.4 GET /api/products/processing-status/:jobId ──────────────────────────
const getStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await loadStateRepo.findById(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job no encontrado' });
    if (job.Enterprise_id !== req.user.enterpriseId) {
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }

    return res.json({
      success:        true,
      jobId:          job.Job_id,
      status:         job.Status,
      currentStep:    job.Current_step,
      metrics:        job.Metrics,
      excelRowCount:  (job.Excel_data  || []).length,
      imageFileCount: (job.Image_files || []).length,
      createdDate:    job.Created_date,
      updatedDate:    job.Updated_date,
      errorMessage:   job.Error_message ?? null,
    });
  } catch (err) { return handleError(res, err); }
};

// ── 10.5 GET /api/products ───────────────────────────────────────────────────
const listProducts = async (req, res) => {
  try {
    const { categoryId, search, page, limit } = req.query;
    const result = await productService.listByEnterprise(req.user.enterpriseId, {
      categoryId, search,
      page:  page  ? Number(page)  : 1,
      limit: limit ? Number(limit) : 50,
    });
    return res.json({ success: true, ...result });
  } catch (err) { return handleError(res, err); }
};

// ── Menú por rol 2026-07-25 — GET /api/products/global ───────────────────────
// Catálogo global derivado de RETSC_OP_SKUS (RETSC_OP_PRODUCTS ya no existe —
// commit b775f86). Exclusivo ADMIN_DTC (gate en productRoutes.js). Distinto de
// GET /api/skus/global: acá se agrupa por producto, no una fila por EAN.
const listGlobalProducts = async (req, res) => {
  try {
    const { search, page, limit } = req.query;
    const result = await productService.listGlobal({ search, page, limit });
    return res.json({ success: true, ...result });
  } catch (err) { return handleError(res, err); }
};

// ── B5 QA — GET /api/products/categories ─────────────────────────────────────
// Solo categorías que tienen SKUs cargados por la empresa actual, para que el
// dropdown de filtro del frontend no muestre categorías vacías.
const listProductCategories = async (req, res) => {
  try {
    const categories = await productService.listCategoriesWithProducts(req.user.enterpriseId);
    return res.json({ success: true, categories });
  } catch (err) { return handleError(res, err); }
};

module.exports = { uploadExcel, uploadImages, processJob, getStatus, listProducts, listProductCategories, listGlobalProducts };
