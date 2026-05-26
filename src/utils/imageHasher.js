const crypto = require('crypto');
const fs     = require('fs').promises;

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return hashBuffer(buffer);
}

async function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { hashFile, hashBuffer };
