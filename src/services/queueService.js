// Servicio de encolado para procesamiento cognitivo de imágenes SKU.
//
// Encola mensajes en Azure Queue Storage ('sku-image-processing') para que la
// Azure Function ProcessSkuImageQueue los procese con OCR + embeddings.
//
// Variables de entorno:
//   AZURE_STORAGE_CONNECTION_STRING — requerida en producción; si no está, modo mock (sin cola)
//   AZURE_QUEUE_NAME                — nombre de la cola (default: 'sku-image-processing')
//
// NOTA: encolar NUNCA debe romper el upload. Todas las funciones capturan sus errores,
//   loguean y devuelven false para que el llamador pueda continuar sin interrumpir el flujo.

const { QueueServiceClient } = require('@azure/storage-queue');

const QUEUE_NAME = process.env.AZURE_QUEUE_NAME || 'sku-image-processing';

// Cliente lazy: se inicializa una sola vez al primer uso.
let queueClient = null;

function getQueueClient() {
  if (queueClient) return queueClient;
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) {
    // Sin connection string → modo mock. El llamador loguea un warning.
    return null;
  }
  const svc = QueueServiceClient.fromConnectionString(cs);
  queueClient = svc.getQueueClient(QUEUE_NAME);
  return queueClient;
}

// Encola una imagen para procesamiento cognitivo (OCR + embeddings).
//
// Parámetros:
//   skuId      — id del SKU dueño de la imagen
//   featureId  — id en RETSC_AI_SKU_FEATURES (la Function actualiza esa fila)
//   imageUrl   — URL del blob (la Function la lee para hacer OCR)
//   ean        — EAN del SKU (útil para el índice de búsqueda)
//
// El mensaje se codifica en base64 (requisito de Azure Queue Storage).
// Devuelve true si se encoló, false si no (sin lanzar excepción).
async function enqueueSkuImageProcessing({ skuId, featureId, imageUrl, ean }) {
  try {
    const client = getQueueClient();
    if (!client) {
      console.warn('[queue] AZURE_STORAGE_CONNECTION_STRING no configurado — no se encola', { skuId, featureId });
      return false;
    }
    await client.createIfNotExists();
    const payload = JSON.stringify({ sku_id: skuId, feature_id: featureId, image_url: imageUrl, ean });
    const message = Buffer.from(payload).toString('base64');
    await client.sendMessage(message);
    console.log('[queue] encolado', { skuId, featureId, ean });
    return true;
  } catch (err) {
    console.error('[queue] error al encolar (no bloquea el upload)', { skuId, featureId, error: err.message });
    return false;
  }
}

module.exports = { enqueueSkuImageProcessing };
