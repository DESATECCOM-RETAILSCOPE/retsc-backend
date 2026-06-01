const { getPool, sql } = require("../config/db");

const TABLE = "RETSC_OP_CATEGORIES";

// ────────────── Lectura ──────────────

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("id", sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE Category_id = @id`);
  return r.recordset[0] ?? null;
};

const findRoots = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`
      SELECT * FROM ${TABLE}
      WHERE parent_category_id IS NULL
        AND status = 'ACTIVE'
      ORDER BY Category_dsc
    `);
  return r.recordset;
};

const findChildren = async (parentId) => {
  const pool = await getPool();
  const r = await pool.request().input("parentId", sql.Int, parentId).query(`
      SELECT * FROM ${TABLE}
      WHERE parent_category_id = @parentId
        AND status = 'ACTIVE'
      ORDER BY Category_dsc
    `);
  return r.recordset;
};

const listActive = async () => {
  // Mantenida por compatibilidad con aiService y categoryService (issues 2.x)
  const pool = await getPool();
  const r = await pool.request().query(`
      SELECT * FROM ${TABLE}
      WHERE status = 'ACTIVE'
      ORDER BY level_no, Category_dsc
    `);
  return r.recordset;
};

const listAll = async () => {
  const pool = await getPool();
  const r = await pool
    .request()
    .query(`SELECT * FROM ${TABLE} ORDER BY level_no, Category_dsc`);
  return r.recordset;
};

const findActiveDescendants = async (categoryId) => {
  // CTE recursivo: trae todos los Category_id de descendientes activos
  const pool = await getPool();
  const r = await pool.request().input("id", sql.Int, categoryId).query(`
      WITH Descendants AS (
        SELECT Category_id
        FROM ${TABLE}
        WHERE parent_category_id = @id
          AND status = 'ACTIVE'
        UNION ALL
        SELECT c.Category_id
        FROM ${TABLE} c
        INNER JOIN Descendants d ON c.parent_category_id = d.Category_id
        WHERE c.status = 'ACTIVE'
      )
      SELECT Category_id FROM Descendants
    `);
  return r.recordset.map((row) => row.Category_id);
};

// ────────────── Escritura ──────────────

const insert = async (category) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("dsc", sql.VarChar(50), category.Category_dsc)
    .input("levelNo", sql.Int, category.level_no)
    .input("parentId", sql.Int, category.parent_category_id ?? null)
    .input("smartDtc", sql.Bit, category.is_smart_dtc ?? 0)
    .input("status", sql.VarChar(20), category.status ?? "ACTIVE").query(`
      INSERT INTO ${TABLE}
        (Category_dsc, level_no, parent_category_id, is_smart_dtc, status)
      OUTPUT INSERTED.*
      VALUES
        (@dsc, @levelNo, @parentId, @smartDtc, @status)
    `);
  return r.recordset[0];
};

const update = async (id, partial) => {
  const pool = await getPool();
  const req = pool.request().input("id", sql.Int, id);
  const set = [];

  if (partial.Category_dsc !== undefined) {
    req.input("dsc", sql.VarChar(50), partial.Category_dsc);
    set.push("Category_dsc = @dsc");
  }
  if (partial.status !== undefined) {
    req.input("status", sql.VarChar(20), partial.status);
    set.push("status = @status");
  }
  if (partial.is_smart_dtc !== undefined) {
    req.input("smartDtc", sql.Bit, partial.is_smart_dtc);
    set.push("is_smart_dtc = @smartDtc");
  }
  if (partial.parent_category_id !== undefined) {
    req.input("parentId", sql.Int, partial.parent_category_id);
    set.push("parent_category_id = @parentId");
  }
  if (partial.level_no !== undefined) {
    req.input("levelNo", sql.Int, partial.level_no);
    set.push("level_no = @levelNo");
  }

  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE ${TABLE} SET ${set.join(", ")}
    OUTPUT INSERTED.*
    WHERE Category_id = @id
  `);
  return r.recordset[0] ?? null;
};

const updateManyStatus = async (ids, status) => {
  // Para soft-delete en cascada: inactiva múltiples IDs a la vez
  if (!ids.length) return;
  const pool = await getPool();
  const req = pool.request().input("status", sql.VarChar(20), status);
  const placeholders = ids.map((id, i) => {
    req.input(`id${i}`, sql.Int, id);
    return `@id${i}`;
  });
  await req.query(`
    UPDATE ${TABLE}
    SET status = @status
    WHERE Category_id IN (${placeholders.join(", ")})
  `);
};

module.exports = {
  findById,
  findRoots,
  findChildren,
  listActive, // compatibilidad con aiService y categoryService existentes
  listAll,
  findActiveDescendants,
  insert,
  update,
  updateManyStatus,
};
