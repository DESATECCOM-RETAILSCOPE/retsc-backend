const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// Per-file lock: chains promises so concurrent ops on the same file are serialized
const locks = new Map();

function withLock(table, fn) {
  const prev = locks.get(table) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(table, next.then(() => {}, () => {}));
  return next;
}

function filePath(table) {
  return path.join(DATA_DIR, `${table}.json`);
}

async function readRaw(table) {
  try {
    const raw = await fs.readFile(filePath(table), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeRaw(table, data) {
  await fs.writeFile(filePath(table), JSON.stringify(data, null, 2), 'utf8');
}

async function readAll(table) {
  return withLock(table, () => readRaw(table));
}

async function readById(table, id, pkField) {
  return withLock(table, async () => {
    const data = await readRaw(table);
    return data.find(r => r[pkField] === id) ?? null;
  });
}

async function findOne(table, predicate) {
  return withLock(table, async () => {
    const data = await readRaw(table);
    return data.find(predicate) ?? null;
  });
}

async function findMany(table, predicate) {
  return withLock(table, async () => {
    const data = await readRaw(table);
    return data.filter(predicate);
  });
}

async function nextId(table, pkField) {
  const data = await readRaw(table);
  if (data.length === 0) return 1;
  return Math.max(...data.map(r => r[pkField] || 0)) + 1;
}

async function insert(table, record, pkField) {
  return withLock(table, async () => {
    const data = await readRaw(table);
    const toInsert = { ...record };
    if (toInsert[pkField] == null) {
      const ids = data.map(r => r[pkField] || 0);
      toInsert[pkField] = ids.length === 0 ? 1 : Math.max(...ids) + 1;
    }
    data.push(toInsert);
    await writeRaw(table, data);
    return toInsert;
  });
}

async function update(table, id, partial, pkField) {
  return withLock(table, async () => {
    const data = await readRaw(table);
    const idx = data.findIndex(r => r[pkField] === id);
    if (idx === -1) return null;
    data[idx] = { ...data[idx], ...partial };
    await writeRaw(table, data);
    return data[idx];
  });
}

async function remove(table, id, pkField) {
  return withLock(table, async () => {
    const data = await readRaw(table);
    const idx = data.findIndex(r => r[pkField] === id);
    if (idx === -1) return false;
    data.splice(idx, 1);
    await writeRaw(table, data);
    return true;
  });
}

// Run an arbitrary async fn inside the file lock for `table`
async function transaction(table, fn) {
  return withLock(table, fn);
}

module.exports = { readAll, readById, findOne, findMany, insert, update, remove, nextId, transaction };
