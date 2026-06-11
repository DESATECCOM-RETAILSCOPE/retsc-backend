// Servicio de carga de imágenes de SKU.
//
// Tablas que usa:
//   RETSC_AI_SKU_FEATURES       — registro de imagen por SKU (fuente de verdad)
//   RETSC_AI_SKU_IMAGE_METADATA — metadata extendida en key-value
//   RETSC_LOG_IMAGE_UPLOAD      — log de cada intento de carga
//   RETSC_OP_SKUS               — lookup de SKU por EAN
//   RETSC_OP_PRODUCTS           — para resolver categoría del blob path
//   RETSC_OP_CATEGORIES         — is_smart_dtc y slug del blob path
//
// Flujo de huérfanas:
//   - EAN sin SKU → blob sube a 'huerfanas/{ean}_{view}.{ext}', log con process_status='ORPHAN'
//   - NO se inserta en RETSC_AI_SKU_FEATURES (María: "no carguemos nada en SKU_FEATURES")
//   - Cuando se crea el SKU → resolveOrphansForSku lo adopta retroactivamente
//
// Blob paths (container 'global-sku-training'):
//   - Categoría smart, primary:   dtc-{slug}/{EAN}.{ext}              — sin sufijo de vista
//   - Categoría smart, secundaria: dtc-{slug}/{EAN}_{vista}.{ext}
//   - Categoría no-smart:         sin-categoria-smart/{EAN}_{vista}.{ext}
//   - Huérfana:                   huerfanas/{EAN}_{vista}.{ext}        — siempre con sufijo

const fs                    = require('fs').promises;
const crypto                = require('crypto');
const { hashFile }          = require('../utils/imageHasher');
const { parseFilename }     = require('../utils/skuImageFilenameParser');
const { generateFilename }  = require('../utils/skuImageFilenameGenerator');
const { normalizeName }     = require('../utils/categoryNameNormalizer');
const skuFeatureRepo        = require('../repositories/skuFeatureRepo');
const skuImageLogRepo       = require('../repositories/skuImageLogRepo');
const { getPool, sql }      = require('../config/db');
const { uploadToContainer } = require('./blobStorageService');

const TRAINING_CONTAINER = () => process.env.AZURE_GLOBAL_TRAINING_CONTAINER || 'global-sku-training';

// ─── Helpers internos ─────────────────────────────────────────────────────────

async function findSkuByEan(ean) {
  const pool = await getPool();
  const r = await pool.request()
    .input('ean', sql.VarChar(18), ean)
    .query(`SELECT TOP 1 * FROM RETSC_OP_SKUS WHERE EAN = @ean`);
  return r.recordset[0] ?? null;
}

// Resuelve el prefijo de blob para un SKU según la categoría de su producto.
// Reutiliza normalizeName de Pasada 1 para garantizar que el slug coincida
// con el prefix creado por aiInfrastructureService.
//
// En producción todos los SKUs deberían tener categoría smart. Si no la tienen,
// loguea un warning estructurado para detectar el problema sin bloquear el upload.
async function getBlobPrefixForSku(skuId, ean) {
  const pool = await getPool();
  const r = await pool.request()
    .input('skuId', sql.Int, skuId)
    .query(`
      SELECT c.Category_dsc, c.is_smart_dtc, c.Category_id, p.product_id
      FROM RETSC_OP_SKUS s
      JOIN RETSC_OP_PRODUCTS p ON p.product_id = s.product_id
      LEFT JOIN RETSC_OP_CATEGORIES c ON c.Category_id = p.Category_id
      WHERE s.SKU_ID = @skuId
    `);
  const row = r.recordset[0];

  if (row && row.Category_dsc && row.is_smart_dtc) {
    return `dtc-${normalizeName(row.Category_dsc)}`;
  }

  // Fallback: producto sin categoría smart asignada.
  // En producción esto NO debería ocurrir — todos los productos deben tener categoría smart.
  console.warn('[skuImage] Producto sin categoría smart asignada', {
    skuId,
    ean,
    productId:   row?.product_id   ?? null,
    categoryId:  row?.Category_id  ?? null,
    categoryDsc: row?.Category_dsc ?? null,
    isSmartDtc:  row?.is_smart_dtc ?? null,
  });
  return 'sin-categoria-smart';
}

// Actualiza image_url y has_visual_variant al subir la primera imagen de un SKU.
async function markSkuFirstImage(skuId, imageUrl) {
  const pool = await getPool();
  await pool.request()
    .input('skuId',    sql.Int,         skuId)
    .input('imageUrl', sql.VarChar(250), imageUrl.slice(0, 250))
    .query(`
      UPDATE RETSC_OP_SKUS
      SET image_url          = @imageUrl,
          has_visual_variant = CAST(1 AS binary(1))
      WHERE SKU_ID = @skuId
    `);
}

function contentTypeForExt(ext) {
  const map = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return map[ext] || 'application/octet-stream';
}

function newBatchId() { return crypto.randomUUID(); }

// Inserta metadata estándar en RETSC_AI_SKU_IMAGE_METADATA.
// TODO: cuando se pueble RETSC_AI_METADATA_DEFINITIONS, resolver metadata_definition_id.
async function insertStandardMetadata(featureId, { uploadedBy, originalFilename, generatedFilename, view, uploadDate, fileSizeKb }) {
  await skuFeatureRepo.insertMetadata(featureId, [
    { key: 'uploaded_by',        value: uploadedBy },
    { key: 'original_filename',  value: originalFilename },
    { key: 'generated_filename', value: generatedFilename },
    { key: 'perspective',        value: view },
    { key: 'upload_date',        value: uploadDate },
    { key: 'file_size_kb',       value: fileSizeKb },
  ]);
}

// ─── processBatch ─────────────────────────────────────────────────────────────

// Procesa un batch de archivos subidos vía multer.
//
// files:        array de { originalname, path, size } (multer)
// uploadedBy:   req.user.userId
// enterpriseId: req.user.enterpriseId (auditoría)
// onProgress:   callback opcional async (counts) → llamado cada 5 archivos y al final.
//               Recibe { processed, orphans, duplicates, errors, warnings }.
//               Si no se pasa, el comportamiento es idéntico al modo síncrono original.
//
// Retorna: { processed, orphans, duplicates, errors, warnings: { noSmartCategory }, details, batchId }
const processBatch = async ({ files, uploadedBy, enterpriseId, onProgress }) => {
  const batchId = newBatchId();
  const summary = {
    processed: 0,
    orphans: 0,
    duplicates: 0,
    errors: [],
    warnings: { noSmartCategory: 0 },
    details: [],
  };

  for (const file of files) {
    const detail = { originalFilename: file.originalname, status: null };

    try {
      // 1. Parsear nombre de archivo
      const parsed = parseFilename(file.originalname);
      if (!parsed) {
        detail.status  = 'error';
        detail.message = `Nombre no válido: '${file.originalname}'. Formato esperado: {EAN}_{vista}.{ext}`;
        summary.errors.push(detail.message);
        await skuImageLogRepo.insertLog({
          enterpriseId, uploadBatchId: batchId,
          imageName: file.originalname,
          processStatus: 'ERROR',
          errorCode: 'INVALID_FILENAME', errorMessage: detail.message,
        });
        summary.details.push(detail);
        continue;
      }

      const { ean, view, ext } = parsed;
      const uploadDate         = new Date().toISOString();

      // 2. Hash SHA-256
      const hash = await hashFile(file.path);

      // 3. Buscar SKU por EAN (catálogo global)
      const sku = await findSkuByEan(ean);

      if (!sku) {
        // ── Huérfana: sin SKU → blob con sufijo de vista, log ORPHAN ──
        // Las huérfanas SIEMPRE llevan sufijo (isPrimary no aplica sin SKU).
        const orphanFilename = generateFilename({ ean, view, ext, isPrimary: false });
        const blobPath = `huerfanas/${orphanFilename}`;
        const buffer   = await fs.readFile(file.path);
        const { url }  = await uploadToContainer({
          containerName: TRAINING_CONTAINER(),
          blobPath,
          buffer,
          contentType: contentTypeForExt(ext),
        });

        await skuImageLogRepo.insertLog({
          enterpriseId, uploadBatchId: batchId,
          ean, imageName: file.originalname,
          imageUrl:     url,
          imageHash:    hash,
          imageStatus:  'PENDING_MATCH',
          processStatus: 'ORPHAN',
        });

        detail.status  = 'orphan';
        detail.ean     = ean;
        detail.blobUrl = url;
        detail.message = `EAN ${ean} sin SKU asociado. Imagen guardada como huérfana para adopción futura.`;
        summary.orphans++;

        console.log(`[skuImage] huérfana EAN=${ean} blob=${blobPath} enterprise=${enterpriseId}`);
        summary.details.push(detail);
        continue;
      }

      // 4. Dedup: ¿ya existe esta imagen para este SKU?
      const existing = await skuFeatureRepo.findBySkuIdAndHash(sku.SKU_ID, hash);
      if (existing) {
        detail.status = 'duplicate';
        detail.skuId  = sku.SKU_ID;
        summary.duplicates++;
        await skuImageLogRepo.insertLog({
          enterpriseId, uploadBatchId: batchId,
          skuId: sku.SKU_ID, ean, imageName: file.originalname, imageHash: hash,
          processStatus: 'DUPLICATE',
        });
        summary.details.push(detail);
        continue;
      }

      // 5. Determinar isPrimary ANTES de generar el filename (Mini Pasada 2.1):
      //    La primera imagen activa del SKU se guarda sin sufijo de vista.
      const existingCount = await skuFeatureRepo.countActiveBySku(sku.SKU_ID);
      const isPrimary     = existingCount === 0;

      // 6. Prefijo de blob según categoría
      const prefix   = await getBlobPrefixForSku(sku.SKU_ID, ean);
      if (prefix === 'sin-categoria-smart') summary.warnings.noSmartCategory++;

      // 7. Generar filename con la regla de primary
      const generatedFilename = generateFilename({ ean, view, ext, isPrimary });
      const blobPath          = `${prefix}/${generatedFilename}`;

      // 8. Subir a Blob Storage
      const buffer  = await fs.readFile(file.path);
      const { url } = await uploadToContainer({
        containerName: TRAINING_CONTAINER(),
        blobPath,
        buffer,
        contentType: contentTypeForExt(ext),
      });

      // 9. Insert en RETSC_AI_SKU_FEATURES
      const feature = await skuFeatureRepo.insert({
        skuId: sku.SKU_ID, imageUrl: url, imageHash: hash,
        isPrimary: isPrimary ? 1 : 0,
      });

      // 10. Metadata estándar
      await insertStandardMetadata(feature.feature_id, {
        uploadedBy,
        originalFilename:  file.originalname,
        generatedFilename,
        view,
        uploadDate,
        fileSizeKb: Math.round((file.size || buffer.length) / 1024),
      });

      // 11. Actualizar RETSC_OP_SKUS si es primera imagen
      if (isPrimary) await markSkuFirstImage(sku.SKU_ID, url);

      // 12. Log de éxito
      await skuImageLogRepo.insertLog({
        enterpriseId, uploadBatchId: batchId,
        skuId: sku.SKU_ID, ean, imageName: file.originalname,
        imageUrl: url, imageHash: hash,
        imageStatus: 'UPLOADED', processStatus: 'COMPLETED',
      });

      detail.status    = 'processed';
      detail.skuId     = sku.SKU_ID;
      detail.featureId = feature.feature_id;
      detail.blobUrl   = url;
      detail.prefix    = prefix;
      detail.view      = view;
      detail.isPrimary = isPrimary;
      summary.processed++;

      console.log(`[skuImage] OK EAN=${ean} SKU=${sku.SKU_ID} prefix=${prefix} primary=${isPrimary} enterprise=${enterpriseId}`);

    } catch (err) {
      detail.status  = 'error';
      detail.message = err.message;
      summary.errors.push(`${file.originalname}: ${err.message}`);
      console.error('[skuImage] error procesando', file.originalname, err.message);
      await skuImageLogRepo.insertLog({
        enterpriseId, uploadBatchId: batchId,
        imageName: file.originalname,
        processStatus: 'ERROR',
        errorCode: 'INTERNAL_ERROR', errorMessage: err.message.slice(0, 1000),
      }).catch(() => {});
    } finally {
      await fs.unlink(file.path).catch(() => {});
    }

    summary.details.push(detail);

    // Llamar onProgress cada 5 archivos (si fue provisto)
    if (onProgress && summary.details.length % 5 === 0) {
      await onProgress({
        processed:  summary.processed,
        orphans:    summary.orphans,
        duplicates: summary.duplicates,
        errors:     summary.errors.length,
        warnings:   Object.values(summary.warnings).reduce((a, b) => a + b, 0),
      }).catch(() => {});
    }
  }

  // Llamada final de progreso (para asegurar que el último partial chunk quede reflejado)
  if (onProgress) {
    await onProgress({
      processed:  summary.processed,
      orphans:    summary.orphans,
      duplicates: summary.duplicates,
      errors:     summary.errors.length,
      warnings:   Object.values(summary.warnings).reduce((a, b) => a + b, 0),
    }).catch(() => {});
  }

  return { ...summary, batchId };
};

// ─── resolveOrphansForSku ─────────────────────────────────────────────────────

// Adopta huérfanas del log (process_status='ORPHAN') para un EAN dado.
// Llamar cuando se crea un nuevo SKU con ese EAN.
//
// Flujo por cada huérfana:
//   a. Lee image_url, image_hash y perspective del log (perspective: parsea image_name)
//   b. NO mueve el blob (image_url queda apuntando a huerfanas/ — OK por ahora)
//   c. INSERT en RETSC_AI_SKU_FEATURES (sku_id, image_url, image_hash, is_primary)
//   d. INSERT en RETSC_AI_SKU_IMAGE_METADATA
//   e. Marca el log como process_status='ADOPTED'
//
// TODO: renombrar el blob de la primera huérfana adoptada (primary) para quitarle
//   el sufijo de vista: copiar de 'huerfanas/{ean}_front.jpg' a 'dtc-{cat}/{ean}.jpg'
//   y eliminar el original. Actualizar image_url en SKU_FEATURES.
//   Requiere acceso a blobStorageService.copyBlob() y blobStorageService.deleteBlob()
//   que no existen aún. Dejar para una pasada posterior.
//
// NOTA: uploaded_by no está disponible en RETSC_LOG_IMAGE_UPLOAD (solo enterprise_id).
//   Se guarda NULL para ese campo de metadata en las huérfanas adoptadas.
//
// Retorna: número de huérfanas adoptadas.
const resolveOrphansForSku = async (skuId, ean) => {
  const orphans = await skuImageLogRepo.findOrphansByEan(ean);
  if (orphans.length === 0) return 0;

  let adopted = 0;

  for (const orphan of orphans) {
    try {
      const parsed            = parseFilename(orphan.image_name || '');
      const view              = parsed?.view || 'front';
      const generatedFilename = parsed
        ? generateFilename({ ean: parsed.ean, view: parsed.view, ext: parsed.ext, isPrimary: false })
        : orphan.image_name;

      // Primera imagen del SKU → is_primary
      const imageCount = await skuFeatureRepo.countActiveBySku(skuId);
      const isPrimary  = imageCount === 0 ? 1 : 0;

      // INSERT en RETSC_AI_SKU_FEATURES
      // NOTA: image_url apunta a huerfanas/ — blob rename pendiente (ver TODO arriba)
      const feature = await skuFeatureRepo.insert({
        skuId,
        imageUrl:  orphan.image_url,
        imageHash: orphan.image_hash,
        isPrimary,
      });

      // INSERT metadata (uploaded_by=NULL: no disponible en el log)
      await insertStandardMetadata(feature.feature_id, {
        uploadedBy:        null,
        originalFilename:  orphan.image_name,
        generatedFilename,
        view,
        uploadDate:        orphan.created_at?.toISOString() ?? new Date().toISOString(),
        fileSizeKb:        null,
      });

      if (isPrimary) await markSkuFirstImage(skuId, orphan.image_url);

      await skuImageLogRepo.markAdopted(orphan.image_log_id, skuId);

      adopted++;
      console.log(`[skuImage] adoptada log_id=${orphan.image_log_id} EAN=${ean} → SKU=${skuId}`);

    } catch (err) {
      console.error(`[skuImage] error adoptando log_id=${orphan.image_log_id}`, err.message);
    }
  }

  return adopted;
};

// ─── listImagesBySkuId ────────────────────────────────────────────────────────

const listImagesBySkuId = async (skuId) => {
  return skuFeatureRepo.findBySkuId(skuId);
};

module.exports = { processBatch, resolveOrphansForSku, listImagesBySkuId };
