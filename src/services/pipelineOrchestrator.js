const fs              = require('fs').promises;
const path            = require('path');
const loadStateRepo   = require('../repositories/loadStateRepo');
const productRepo     = require('../repositories/productRepo');
const imageRepo       = require('../repositories/imageRepo');
const { validateGTIN }                              = require('../utils/gtinValidator');
const { hashFile }                                  = require('../utils/imageHasher');
const { matchImagesToProducts }                     = require('./matchingService');
const { buildBatchCounts, decidePathForProduct }    = require('./hierarchyService');
const { uploadImagesBatch }                         = require('./blobStorageService');
const aiService                                     = require('./aiService');

const UPLOADS_TEMP = path.join(__dirname, '..', '..', 'uploads-temp');

function now() { return new Date().toISOString(); }

async function setStep(jobId, step, extra = {}) {
  await loadStateRepo.update(jobId, { Current_step: step, Updated_date: now(), ...extra });
}

async function mergeMetrics(jobId, partial) {
  const job = await loadStateRepo.findById(jobId);
  await loadStateRepo.update(jobId, {
    Metrics: { ...job.Metrics, ...partial },
    Updated_date: now(),
  });
}

async function failJob(jobId, message) {
  await loadStateRepo.update(jobId, {
    Status: 'failed', Current_step: null,
    Error_message: message, Updated_date: now(),
  });
}

async function cleanupTempFiles(jobId) {
  const dir = path.join(UPLOADS_TEMP, jobId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
async function executePipeline(jobId) {
  let job = await loadStateRepo.findById(jobId);
  if (!job) throw new Error(`Job ${jobId} no encontrado`);

  const { Enterprise_id: enterpriseId, Excel_data: excelRows = [], Image_files: imageFiles = [] } = job;

  try {
    // ── Paso A: Validar GTINs ────────────────────────────────────────────────
    await setStep(jobId, 'validating_gtins', { Status: 'processing' });

    const validRows = [];
    const invalidGtins = [];
    for (const row of excelRows) {
      const result = validateGTIN(String(row.gtin || ''));
      if (result.valid) {
        validRows.push(row);
      } else {
        invalidGtins.push({ gtin: row.gtin, reason: result.reason });
      }
    }
    await mergeMetrics(jobId, { validGtins: validRows.length, invalidGtins });

    if (validRows.length === 0) {
      await failJob(jobId, 'Ningún GTIN del Excel pasó la validación');
      return await loadStateRepo.findById(jobId);
    }

    // ── Paso B: Hashear imágenes y deduplicar ────────────────────────────────
    await setStep(jobId, 'hashing');

    const validImages = [];
    const duplicateImages = [];
    const seenHashes = new Set();

    for (const imgFile of imageFiles) {
      let hash;
      try {
        hash = await hashFile(imgFile.tempPath);
      } catch {
        duplicateImages.push({ originalName: imgFile.originalName, reason: 'archivo no accesible' });
        continue;
      }

      // Deduplicar contra histórico en BD
      const existsInDb = await imageRepo.findByHash(hash, enterpriseId);
      if (existsInDb) {
        duplicateImages.push({ originalName: imgFile.originalName, reason: 'hash duplicado en historial' });
        continue;
      }

      // Deduplicar intra-lote
      if (seenHashes.has(hash)) {
        duplicateImages.push({ originalName: imgFile.originalName, reason: 'hash duplicado en lote' });
        continue;
      }

      seenHashes.add(hash);
      validImages.push({ ...imgFile, hash });
    }

    await mergeMetrics(jobId, { totalImages: imageFiles.length, duplicateImages });

    // ── Paso C: Matching ─────────────────────────────────────────────────────
    await setStep(jobId, 'matching');

    const { matched, imagesWithoutMatch, productsWithoutImage } =
      matchImagesToProducts(validRows, validImages);

    await mergeMetrics(jobId, {
      unmatchedImages:     imagesWithoutMatch.map(i => i.originalName),
      productsWithoutImage: productsWithoutImage.map(p => p.gtin),
    });

    if (matched.length === 0) {
      await failJob(jobId, 'Ninguna imagen coincidió con los GTINs del Excel');
      return await loadStateRepo.findById(jobId);
    }

    // ── Paso D: Jerarquía ────────────────────────────────────────────────────
    await setStep(jobId, 'hierarchy');

    const matchedProductRows = matched.map(m => m.productRow);
    const batchCounts = await buildBatchCounts(matchedProductRows, enterpriseId);

    const matchedWithPaths = await Promise.all(
      matched.map(async (m) => ({
        ...m,
        relativePath: await decidePathForProduct(m.productRow, enterpriseId, batchCounts),
      }))
    );

    // ── Paso E: Subir imágenes ───────────────────────────────────────────────
    await setStep(jobId, 'uploading');

    const toUpload = matchedWithPaths.map(m => ({
      buffer:       null, // se lee justo abajo
      relativePath: m.relativePath,
      filename:     m.imageFile.originalName,
      _match:       m,
    }));

    // Leer buffers
    for (const item of toUpload) {
      item.buffer = await fs.readFile(item._match.imageFile.tempPath).catch(() => null);
    }

    const uploadInput = toUpload
      .filter(i => i.buffer !== null)
      .map(i => ({ buffer: i.buffer, relativePath: i.relativePath, filename: i.filename }));

    const uploadResults = await uploadImagesBatch(uploadInput);
    const urlByFilename = new Map(uploadResults.filter(r => r.success).map(r => [r.filename, r.url]));

    const failedUploads = uploadResults.filter(r => !r.success);
    const failRate = uploadInput.length > 0 ? failedUploads.length / uploadInput.length : 0;
    if (failRate > 0.5) {
      await failJob(jobId, `Más del 50% de las imágenes fallaron en upload (${failedUploads.length}/${uploadInput.length})`);
      return await loadStateRepo.findById(jobId);
    }

    await mergeMetrics(jobId, { uploaded: urlByFilename.size });

    // ── Paso F: Persistir ────────────────────────────────────────────────────
    await setStep(jobId, 'persisting');

    const toInsert = [];
    const toUpdate = [];
    const imageInserts = [];

    for (const m of matchedWithPaths) {
      const url = urlByFilename.get(m.imageFile.originalName);
      if (!url) continue; // imagen falló en upload

      const existing = await productRepo.findByGtinAndEnterprise(m.gtin, enterpriseId);
      const productData = {
        Enterprise_id:  enterpriseId,
        GTIN:           m.productRow.gtin,
        Description:    m.productRow.description,
        Category_name:  m.productRow.category,
        Subcategory:    m.productRow.subcategory,
        Segment:        m.productRow.segment,
        Brand:          m.productRow.brand,
        Primary_image_url: url,
        Status:         1,
        Created_date:   now(),
      };

      if (existing) {
        toUpdate.push({ id: existing.Product_id, partial: { ...productData, Created_date: existing.Created_date } });
        imageInserts.push({ productId: existing.Product_id, hash: m.imageFile.hash, url });
      } else {
        toInsert.push({ data: productData, hash: m.imageFile.hash, url });
      }
    }

    // Actualizar existentes
    for (const { id, partial } of toUpdate) {
      await productRepo.update(id, partial);
    }

    // Insertar nuevos
    const insertedProducts = await productRepo.insertMany(toInsert.map(i => i.data));
    for (let i = 0; i < insertedProducts.length; i++) {
      imageInserts.push({ productId: insertedProducts[i].Product_id, hash: toInsert[i].hash, url: toInsert[i].url });
    }

    // Insertar imágenes
    await imageRepo.insertMany(
      imageInserts.map(({ productId, hash, url }) => ({
        Product_id:   productId,
        Enterprise_id: enterpriseId,
        Hash:         hash,
        Blob_url:     url,
        Status:       1,
        Created_date: now(),
      }))
    );

    await mergeMetrics(jobId, { inserted: toInsert.length });

    // ── Paso G: AI tracking ──────────────────────────────────────────────────
    await setStep(jobId, 'ai_tracking');

    const categories = [...new Set(matched.map(m => m.productRow.category).filter(Boolean))];
    if (categories.length > 0) {
      await aiService.registerTrainingNeed(enterpriseId, categories);
    }

    // ── Completado ───────────────────────────────────────────────────────────
    await loadStateRepo.update(jobId, {
      Status: 'completed', Current_step: null, Updated_date: now(),
    });

    return await loadStateRepo.findById(jobId);

  } catch (err) {
    await failJob(jobId, err.message || String(err));
    return await loadStateRepo.findById(jobId);
  } finally {
    await cleanupTempFiles(jobId);
  }
}

module.exports = { executePipeline };
