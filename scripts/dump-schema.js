/**
 * Genera un mapa completo del schema real de la BD (todas las tablas, no solo
 * las que ya tienen repositorio) para diseñar endpoints nuevos con datos reales
 * en vez de asumir columnas. Solo lectura — consulta INFORMATION_SCHEMA y
 * sys.foreign_keys, no modifica nada.
 *
 * Uso: node scripts/dump-schema.js  →  escribe docs/DB-SCHEMA.md
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

const config = {
  server: process.env.SQL_SERVER,
  port: parseInt(process.env.SQL_PORT) || 1433,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  options: { encrypt: true, trustServerCertificate: true },
};

const TABLES_QUERY = `
  SELECT TABLE_NAME
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_TYPE = 'BASE TABLE'
  ORDER BY TABLE_NAME
`;

const COLUMNS_QUERY = `
  SELECT
    c.TABLE_NAME,
    c.COLUMN_NAME,
    c.DATA_TYPE,
    c.CHARACTER_MAXIMUM_LENGTH,
    c.IS_NULLABLE,
    c.COLUMN_DEFAULT,
    COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY
  FROM INFORMATION_SCHEMA.COLUMNS c
  ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
`;

const PK_QUERY = `
  SELECT
    tc.TABLE_NAME,
    kcu.COLUMN_NAME
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
    ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
`;

const FK_QUERY = `
  SELECT
    fk.name AS FK_NAME,
    tp.name AS TABLE_NAME,
    cp.name AS COLUMN_NAME,
    tr.name AS REF_TABLE_NAME,
    cr.name AS REF_COLUMN_NAME
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
  JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
  JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
  JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
  JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
  ORDER BY tp.name
`;

const INDEX_QUERY = `
  SELECT
    t.name AS TABLE_NAME,
    i.name AS INDEX_NAME,
    i.is_unique AS IS_UNIQUE,
    i.filter_definition AS FILTER_DEF,
    STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS COLUMNS
  FROM sys.indexes i
  JOIN sys.tables t ON t.object_id = i.object_id
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.name IS NOT NULL AND i.is_primary_key = 0
  GROUP BY t.name, i.name, i.is_unique, i.filter_definition
  ORDER BY t.name, i.name
`;

const ROWCOUNT_QUERY = `
  SELECT t.name AS TABLE_NAME, SUM(p.rows) AS ROW_COUNT
  FROM sys.tables t
  JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
  GROUP BY t.name
`;

function fmtType(col) {
  if (col.CHARACTER_MAXIMUM_LENGTH != null && col.CHARACTER_MAXIMUM_LENGTH !== -1) {
    return `${col.DATA_TYPE}(${col.CHARACTER_MAXIMUM_LENGTH})`;
  }
  if (col.CHARACTER_MAXIMUM_LENGTH === -1) return `${col.DATA_TYPE}(MAX)`;
  return col.DATA_TYPE;
}

async function main() {
  console.log('Conectando a', config.database, 'en', config.server, '...');
  const pool = await sql.connect(config);

  const [tablesRes, columnsRes, pkRes, fkRes, indexRes, rowCountRes] = await Promise.all([
    pool.request().query(TABLES_QUERY),
    pool.request().query(COLUMNS_QUERY),
    pool.request().query(PK_QUERY),
    pool.request().query(FK_QUERY),
    pool.request().query(INDEX_QUERY),
    pool.request().query(ROWCOUNT_QUERY),
  ]);

  const tables = tablesRes.recordset.map((r) => r.TABLE_NAME);
  const columnsByTable = {};
  for (const col of columnsRes.recordset) {
    (columnsByTable[col.TABLE_NAME] ??= []).push(col);
  }
  const pkByTable = {};
  for (const row of pkRes.recordset) {
    (pkByTable[row.TABLE_NAME] ??= new Set()).add(row.COLUMN_NAME);
  }
  const fkByTable = {};
  for (const row of fkRes.recordset) {
    (fkByTable[row.TABLE_NAME] ??= []).push(row);
  }
  const indexByTable = {};
  for (const row of indexRes.recordset) {
    (indexByTable[row.TABLE_NAME] ??= []).push(row);
  }
  const rowCountByTable = {};
  for (const row of rowCountRes.recordset) {
    rowCountByTable[row.TABLE_NAME] = row.ROW_COUNT;
  }

  let md = `# DB Schema — ${config.database} (${config.server})\n\n`;
  md += `Generado automáticamente por \`scripts/dump-schema.js\` contra la BD real (solo lectura). No editar a mano — volver a correr el script si la BD cambia.\n\n`;
  md += `Total de tablas: ${tables.length}\n\n`;
  md += `## Índice\n\n`;
  md += tables.map((t) => `- [${t}](#${t.toLowerCase().replace(/_/g, '')})`).join('\n') + '\n\n';

  for (const table of tables) {
    const cols = columnsByTable[table] || [];
    const pk = pkByTable[table] || new Set();
    const fks = fkByTable[table] || [];
    const indexes = indexByTable[table] || [];
    const rowCount = rowCountByTable[table] ?? '?';

    md += `## ${table}\n\n`;
    md += `Filas: ~${rowCount}\n\n`;
    md += `| Columna | Tipo | Nullable | Default | PK | Identity |\n`;
    md += `|---|---|---|---|---|---|\n`;
    for (const col of cols) {
      const isPk = pk.has(col.COLUMN_NAME) ? 'PK' : '';
      const isIdentity = col.IS_IDENTITY ? 'IDENTITY' : '';
      md += `| ${col.COLUMN_NAME} | ${fmtType(col)} | ${col.IS_NULLABLE} | ${col.COLUMN_DEFAULT ?? ''} | ${isPk} | ${isIdentity} |\n`;
    }
    md += '\n';

    if (fks.length) {
      md += `FKs:\n`;
      for (const fk of fks) {
        md += `- \`${fk.COLUMN_NAME}\` → \`${fk.REF_TABLE_NAME}.${fk.REF_COLUMN_NAME}\` (${fk.FK_NAME})\n`;
      }
      md += '\n';
    }

    if (indexes.length) {
      md += `Índices:\n`;
      for (const idx of indexes) {
        const unique = idx.IS_UNIQUE ? 'UNIQUE ' : '';
        const filter = idx.FILTER_DEF ? ` WHERE ${idx.FILTER_DEF}` : '';
        md += `- ${unique}\`${idx.INDEX_NAME}\` (${idx.COLUMNS})${filter}\n`;
      }
      md += '\n';
    }
  }

  const outPath = path.join(__dirname, '..', 'docs', 'DB-SCHEMA.md');
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`\n✅ Escrito ${outPath} (${tables.length} tablas)`);

  await pool.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Falló:', err.message);
  process.exit(1);
});
