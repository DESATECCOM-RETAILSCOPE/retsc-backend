const fs   = require('fs').promises;
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', '..');

function getMode() {
  return (process.env.BLOB_STORAGE_MODE || 'mock').toLowerCase();
}

function getMockBasePath() {
  return path.join(BACKEND_ROOT, process.env.BLOB_MOCK_BASE_PATH || 'data/blob-mock');
}

// Cliente Azure lazy-inicializado para el container de imágenes de productos.
// Solo se usa en uploadImage/uploadImagesBatch (pipeline de carga de productos).
let _azureContainerClient = null;
function getAzureContainer() {
  if (_azureContainerClient) return _azureContainerClient;
  const { BlobServiceClient } = require('@azure/storage-blob');
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const container = process.env.AZURE_BLOB_CONTAINER;
  if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING es requerida en modo azure');
  if (!container) throw new Error('AZURE_BLOB_CONTAINER es requerida en modo azure');
  _azureContainerClient = BlobServiceClient.fromConnectionString(connStr).getContainerClient(container);
  return _azureContainerClient;
}

// Devuelve un ContainerClient para CUALQUIER container (sin caché, uso puntual).
// Usado por las funciones de infraestructura (createMarker, prefixExists, ensureContainerExists).
function getAzureContainerByName(containerName) {
  const { BlobServiceClient } = require('@azure/storage-blob');
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING es requerida en modo azure');
  return BlobServiceClient.fromConnectionString(connStr).getContainerClient(containerName);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, label = '') {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

async function uploadImage(buffer, relativePath, filename) {
  const mode = getMode();

  if (mode === 'azure') {
    return withRetry(async () => {
      const container = getAzureContainer();
      const blobName = relativePath + filename;
      const blobClient = container.getBlockBlobClient(blobName);
      await blobClient.uploadData(buffer);
      return { url: blobClient.url, mode: 'azure' };
    }, filename);
  }

  // mock
  const dir = path.join(getMockBasePath(), relativePath);
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, filename);
  await fs.writeFile(dest, buffer);
  const relUrl = '/blob-mock/' + path.join(relativePath, filename).replace(/\\/g, '/');
  return { url: relUrl, mode: 'mock' };
}

async function uploadImagesBatch(images) {
  const CONCURRENCY = 10;
  const results = [];

  for (let i = 0; i < images.length; i += CONCURRENCY) {
    const chunk = images.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async ({ buffer, relativePath, filename }) => {
        try {
          const { url, mode } = await uploadImage(buffer, relativePath, filename);
          return { filename, url, mode, success: true };
        } catch (err) {
          return { filename, url: null, mode: getMode(), success: false, error: err.message };
        }
      })
    );
    results.push(...chunkResults);
  }
  return results;
}

// ─── Infraestructura de containers (Issue 3.1.1) ────────────────────────────
//
// Estas funciones operan sobre containers arbitrarios (no solo AZURE_BLOB_CONTAINER).
// Se usan al provisionar infraestructura para categorías smart DTC.

// Crea un archivo marcador vacío (.keep) dentro de un prefijo para que sea visible
// en el Portal de Azure como una "carpeta". Si ya existe, no hace nada.
//
// En mock: crea el directorio y el archivo en data/blob-mock/{containerName}/{prefix}/.keep
async function createMarker({ containerName, prefix }) {
  const mode = getMode();
  const blobPath = `${prefix}/.keep`;

  if (mode === 'azure') {
    return withRetry(async () => {
      const container = getAzureContainerByName(containerName);
      const blobClient = container.getBlockBlobClient(blobPath);
      const exists = await blobClient.exists();
      if (!exists) {
        // Sube un blob vacío con tipo texto para que sea inspeccionable en el Portal
        await blobClient.upload('', 0, { blobHTTPHeaders: { blobContentType: 'text/plain' } });
      }
    }, blobPath);
  }

  // mock
  const dir = path.join(getMockBasePath(), containerName, prefix);
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, '.keep');
  try {
    await fs.access(dest);
    // Ya existe, no hacer nada
  } catch {
    await fs.writeFile(dest, '');
  }
}

// Verifica si ya existe al menos un blob bajo un prefijo dado.
// Útil para idempotencia: evitar duplicar .keep si ya hay contenido.
//
// En mock: verifica si el directorio existe.
async function prefixExists({ containerName, prefix }) {
  const mode = getMode();
  const searchPrefix = `${prefix}/`;

  if (mode === 'azure') {
    const container = getAzureContainerByName(containerName);
    // listBlobsFlat devuelve un iterable; con el primer elemento ya alcanza
    for await (const _blob of container.listBlobsFlat({ prefix: searchPrefix })) {
      return true;
    }
    return false;
  }

  // mock
  const dir = path.join(getMockBasePath(), containerName, prefix);
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
}

// Asegura que un container existe en Azure Storage (lo crea si no existe).
// NO se usa para el container global de entrenamiento (que ya existe), pero queda
// disponible por si en el futuro se necesita crear containers dinámicamente.
//
// En mock: crea el directorio correspondiente.
async function ensureContainerExists(containerName) {
  const mode = getMode();

  if (mode === 'azure') {
    const container = getAzureContainerByName(containerName);
    await container.createIfNotExists();
    return;
  }

  // mock
  const dir = path.join(getMockBasePath(), containerName);
  await fs.mkdir(dir, { recursive: true });
}

module.exports = { uploadImage, uploadImagesBatch, createMarker, prefixExists, ensureContainerExists };
