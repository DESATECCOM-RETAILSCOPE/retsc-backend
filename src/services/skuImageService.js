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
//   - Categoría smart:    dtc-{slug}/{EAN}_{vista}.{ext}
//   - Categoría no-smart: sin-categoria-smart/{EAN}_{vista}.{ext}
//   - Huérfana:           huerfanas/{EAN}_{vista}.{ext}

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
async function getBlobPrefixForSku(skuId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('skuId', sql.Int, skuId)
    .query(`
      SELECT c.Category_dsc, c.is_smart_dtc
      FROM RETSC_OP_SKUS s
      JOIN RETSC_OP_PRODUCTS p ON p.product_id = s.product_id
      LEFT JOIN RETSC_OP_CATEGORIES c ON c.Category_id = p.Category_id
      WHERE s.SKU_ID = @skuId
    `);
  const row = r.recordset[0];
  if (!row || !row.Category_dsc || !row.is_smart_dtc) return 'sin-categoria-smart';
  return `dtc-${normalizeName(row.Category_dsc)}`;
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
    // Gap 4: generated_filename guardado explícitamente
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
//
// Retorna: { processed, orphans, duplicates, errors, details, batchId }
const processBatch = async ({ files, uploadedBy, enterpriseId }) => {
  const batchId = newBatchId();
  const summary = { processed: 0, orphans: 0, duplicates: 0, errors: [], details: [] };

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

      const { ean, view, ext }  = parsed;
      const generatedFilename   = generateFilename({ ean, view, ext });
      const uploadDate          = new Date().toISOString();

      // 2. Hash SHA-256
      const hash = await hashFile(file.path);

      // 3. Buscar SKU por EAN (catálogo global)
      const sku = await findSkuByEan(ean);

      if (!sku) {
        // ── Gap 1+2: Huérfana → subir blob + log con process_status='ORPHAN' ──
        const blobPath = `huerfanas/${generatedFilename}`;
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

      // 5. Prefijo de blob según categoría
      const prefix   = await getBlobPrefixForSku(sku.SKU_ID);
      const blobPath = `${prefix}/${generatedFilename}`;

      // 6. Subir a Blob Storage
      const buffer  = await fs.readFile(file.path);
      const { url } = await uploadToContainer({
        containerName: TRAINING_CONTAINER(),
        blobPath,
        buffer,
        contentType: contentTypeForExt(ext),
      });

      // 7. Primera imagen del SKU → is_primary
      const imageCount = await skuFeatureRepo.countBySku(sku.SKU_ID);
      const isPrimary  = imageCount === 0 ? 1 : 0;

      // 8. Insert en RETSC_AI_SKU_FEATURES
      const feature = await skuFeatureRepo.insert({
        skuId: sku.SKU_ID, imageUrl: url, imageHash: hash, isPrimary,
      });

      // 9. Gap 4: metadata incluye generated_filename
      await insertStandardMetadata(feature.feature_id, {
        uploadedBy,
        originalFilename:  file.originalname,
        generatedFilename,
        view,
        uploadDate,
        fileSizeKb: Math.round((file.size || buffer.length) / 1024),
      });

      // 10. Actualizar RETSC_OP_SKUS si es primera imagen
      if (isPrimary) await markSkuFirstImage(sku.SKU_ID, url);

      // 11. Log de éxito
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
      detail.isPrimary = isPrimary === 1;
      summary.processed++;

      console.log(`[skuImage] OK EAN=${ean} SKU=${sku.SKU_ID} prefix=${prefix} enterprise=${enterpriseId}`);

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
  }

  return { ...summary, batchId };
};

// ─── Gap 3: resolveOrphansForSku ─────────────────────────────────────────────

// Adopta huérfanas del log (process_status='ORPHAN') para un EAN dado.
// Llamar cuando se crea un nuevo SKU con ese EAN.
//
// Flujo por cada huérfana:
//   a. Lee image_url, image_hash y perspective del log (perspective: parsea image_name)
//   b. NO mueve el blob (image_url queda apuntando a huerfanas/ — OK)
//   c. INSERT en RETSC_AI_SKU_FEATURES (sku_id, image_url, image_hash, is_primary)
//   d. INSERT en RETSC_AI_SKU_IMAGE_METADATA
//   e. Marca el log como process_status='ADOPTED'
//
// TODO: enganchar al servicio de creación de SKUs cuando exista ese endpoint.
//
// NOTA: uploaded_by no está disponible en RETSC_LOG_IMAGE_UPLOAD (solo enterprise_id).
// Se guarda NULL para ese campo de metadata en las huérfanas adoptadas.
//
// Retorna: número de huérfanas adoptadas.
const resolveOrphansForSku = async (skuId, ean) => {
  const orphans = await skuImageLogRepo.findOrphansByEan(ean);
  if (orphans.length === 0) return 0;

  let adopted = 0;

  for (const orphan of orphans) {
    try {
      // Recuperar perspective parseando image_name del log
      const parsed = parseFilename(orphan.image_name || '');
      const view             = parsed?.view || 'front';
      const generatedFilename = parsed
        ? generateFilename({ ean: parsed.ean, view: parsed.view, ext: parsed.ext })
        : orphan.image_name;

      // Primera imagen del SKU → is_primary
      const imageCount = await skuFeatureRepo.countBySku(skuId);
      const isPrimary  = imageCount === 0 ? 1 : 0;

      // INSERT en RETSC_AI_SKU_FEATURES
      const feature = await skuFeatureRepo.insert({
        skuId,
        imageUrl:  orphan.image_url,
        imageHash: orphan.image_hash,
        isPrimary,
      });

      // INSERT metadata (uploaded_by=NULL: no disponible en el log)
      await insertStandardMetadata(feature.feature_id, {
        uploadedBy:        null, // TODO: RETSC_LOG_IMAGE_UPLOAD no guarda user_id, solo enterprise_id
        originalFilename:  orphan.image_name,
        generatedFilename,
        view,
        uploadDate:        orphan.created_at?.toISOString() ?? new Date().toISOString(),
        fileSizeKb:        null,
      });

      // Si es la primera imagen, actualizar RETSC_OP_SKUS
      if (isPrimary) await markSkuFirstImage(skuId, orphan.image_url);

      // Marcar log como adoptada
      await skuImageLogRepo.markAdopted(orphan.image_log_id, skuId);

      adopted++;
      console.log(`[skuImage] adoptada log_id=${orphan.image_log_id} EAN=${ean} → SKU=${skuId}`);

    } catch (err) {
      console.error(`[skuImage] error adoptando log_id=${orphan.image_log_id}`, err.message);
      // No interrumpir el loop: intentar adoptar el resto
    }
  }

  return adopted;
};

// ─── listImagesBySkuId ────────────────────────────────────────────────────────

const listImagesBySkuId = async (skuId) => {
  return skuFeatureRepo.findBySkuId(skuId);
};

module.exports = { processBatch, resolveOrphansForSku, listImagesBySkuId };
