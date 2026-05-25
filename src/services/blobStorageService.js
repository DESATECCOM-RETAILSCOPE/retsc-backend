const fs   = require('fs').promises;
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', '..');

function getMode() {
  return (process.env.BLOB_STORAGE_MODE || 'mock').toLowerCase();
}

function getMockBasePath() {
  return path.join(BACKEND_ROOT, process.env.BLOB_MOCK_BASE_PATH || 'data/blob-mock');
}

// Lazy Azure client to avoid hard failure in mock mode
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

module.exports = { uploadImage, uploadImagesBatch };
