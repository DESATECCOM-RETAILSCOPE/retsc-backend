const fs = require('fs').promises;
const path = require('path');
const repo = require('./jsonRepo');

const TABLE = 'enterprisecats';
const PK = 'Id';
const FILE = path.join(__dirname, '..', '..', 'data', `${TABLE}.json`);

const findByEnterprise = (enterpriseId) =>
  repo.findMany(TABLE, r => r.Enterprise_id === enterpriseId);

// Atomically replaces all category relations for an enterprise inside a single lock window
const replaceForEnterprise = (enterpriseId, categoryIds) =>
  repo.transaction(TABLE, async () => {
    let data;
    try {
      data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') data = [];
      else throw e;
    }

    const kept = data.filter(r => r.Enterprise_id !== enterpriseId);
    const maxId = data.length === 0 ? 0 : Math.max(...data.map(r => r[PK] || 0));
    const newRows = categoryIds.map((catId, i) => ({
      [PK]: maxId + i + 1,
      Enterprise_id: enterpriseId,
      Category_id: catId,
    }));

    await fs.writeFile(FILE, JSON.stringify([...kept, ...newRows], null, 2), 'utf8');
    return newRows;
  });

module.exports = { findByEnterprise, replaceForEnterprise };
