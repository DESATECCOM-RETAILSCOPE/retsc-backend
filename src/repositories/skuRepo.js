/**
 * Repositorio SKU — catálogo global y segmentación enterprise.
 *
 * Esquema real en BD (verificado con INFORMATION_SCHEMA + sys.foreign_keys, 2026-07-17;
 * ver docs/TODO-prioridad-3.md / Issue B1-B5 de QA para el historial de esta corrección):
 *   RETSC_OP_SKUS                    (SKU global)
 *   RETSC_OP_ENTERPRISE_PRODUCT_SEG  (segmentación por enterprise — antes se escribía
 *                                      contra una tabla RETSC_OP_ENTERPRISE_SKUS que
 *                                      nunca existió en ningún ambiente)
 *
 * Columnas reales de RETSC_OP_SKUS:
 *   SKU_ID, EAN, image_url, creation_date, image_status,
 *   Product_dsc, status, selected_category_id, detection_category_id
 *
 * Columnas reales de RETSC_OP_ENTERPRISE_PRODUCT_SEG:
 *   seg_id (PK identity), enterprise_id (FK→RETSC_OP_ENTERPRISE), sku_id (FK→RETSC_OP_SKUS),
 *   status, created_at, updated_at, client_category, client_subcategory, Brand, Supplier,
 *   normalized_name, Relevant_feature, volume.
 *   Constraint único (enterprise_id, sku_id) — UQ_RETSC_ENTERPRISE_SKU_SEG.
 *   NOTA: esta tabla NO tiene selected_category_id/detection_category_id — la
 *   categorización "de plataforma" de un SKU vive en RETSC_OP_SKUS (global, no
 *   por-empresa). client_category/client_subcategory SÍ son por-empresa — son
 *   la categorización propia del cliente tal como viene en su Excel de carga
 *   (columnas CATEGORY/SUBCATEGORY), distinta de selected_category_id/
 *   detection_category_id (el árbol oficial de RETSC_OP_CATEGORIES, usado para
 *   IA/DTC). Brand/Supplier/volume/Relevant_feature mapean 1:1 a las columnas
 *   BRAND/MANUFACTURER/VOLUME/RELEVANT del mismo Excel.
 *   NOTA: normalized_name existe en el esquema pero insertEnterpriseSku/updateEnterpriseSku
 *   nunca la escriben — queda NULL siempre, a propósito. Decisión confirmada con el equipo
 *   de negocio (2026-07-23): no se va a implementar, porque las reglas de normalización de
 *   nombres de producto en Costa Rica son demasiado complejas y no existe un catálogo
 *   electrónico nacional de referencia. No es un bug ni un TODO pendiente.
 *
 * Mapeo de categorías en RETSC_OP_SKUS:
 *   selected_category_id  → enterprise_category_id (PK de RETSC_OP_ENTERPRISE_CATEGORIES)
 *   detection_category_id → resolved_category_id (Category_id de RETSC_OP_CATEGORIES, la smart)
 */

const { getPool, sql } = require("../config/db");

// ── RETSC_OP_SKUS ──────────────────────────────────────────────────────────

// Arma el WHERE compartido por el SELECT paginado y el COUNT(*) de listGlobal.
// Mismo patrón que productRepo.buildFilters.
function buildGlobalFilters(req, filters) {
  let whereExtra = '';

  if (filters.search) {
    req.input('search', sql.NVarChar(200), `%${filters.search}%`);
    whereExtra += ' AND (EAN LIKE @search OR Product_dsc LIKE @search)';
  }

  return whereExtra;
}

// GET /api/skus/global — listado global del catálogo (menú por rol 2026-07-25, ítem
// "SKUs globales" de ADMIN_DTC). Paginado con OFFSET/FETCH + COUNT(*), mismo estilo que
// productRepo.listByEnterprise. A propósito NO hace JOIN a RETSC_OP_CATEGORIES para
// resolver nombres de categoría: selected_category_id en esta tabla es en realidad un FK a
// RETSC_OP_ENTERPRISE_CATEGORIES.enterprise_category_id, NO a RETSC_OP_CATEGORIES.Category_id
// (ver header de este archivo) — unirlo directo a RETSC_OP_CATEGORIES devolvería una
// descripción de categoría incorrecta la mayoría de las veces. Solo detection_category_id
// mapea directo a RETSC_OP_CATEGORIES.Category_id, pero se deja sin resolver acá para no
// mezclar un JOIN correcto con uno incorrecto en la misma fila — el frontend puede resolver
// ambos IDs con los endpoints de categorías que ya existen si los necesita mostrar.
const listGlobal = async (filters = {}) => {
  const pool = await getPool();
  const page   = Math.max(1, Number(filters.page)  || 1);
  const limit  = Math.max(1, Number(filters.limit) || 50);
  const offset = (page - 1) * limit;

  const countReq = pool.request();
  const whereExtraCount = buildGlobalFilters(countReq, filters);
  const countResult = await countReq.query(`
    SELECT COUNT(*) AS total
    FROM RETSC_OP_SKUS
    WHERE 1=1
    ${whereExtraCount}
  `);
  const total = countResult.recordset[0]?.total ?? 0;

  const listReq = pool.request()
    .input('offset', sql.Int, offset)
    .input('limit',  sql.Int, limit);
  const whereExtraList = buildGlobalFilters(listReq, filters);
  const r = await listReq.query(`
    SELECT
      SKU_ID, EAN, Product_dsc, status, image_url, image_status,
      creation_date, selected_category_id, detection_category_id
    FROM RETSC_OP_SKUS
    WHERE 1=1
    ${whereExtraList}
    ORDER BY Product_dsc ASC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  `);
  return { rows: r.recordset, total };
};

const findSkuByEan = async (ean) => {
  const pool = await getPool();
  const r = await pool.request().input("ean", sql.VarChar(18), ean).query(`
      SELECT SKU_ID, EAN, Product_dsc, status,
             selected_category_id, detection_category_id,
             image_url, image_status
      FROM RETSC_OP_SKUS
      WHERE EAN = @ean
    `);
  return r.recordset[0] ?? null;
};

const insertSku = async (data) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("ean", sql.VarChar(18), data.ean)
    .input("productDsc", sql.VarChar(100), data.productDsc ?? null)
    .input("selectedCat", sql.Int, data.selectedCategoryId ?? null)
    .input("detectionCat", sql.Int, data.detectionCategoryId ?? null)
    .input("status", sql.VarChar(20), "ACTIVE").query(`
      INSERT INTO RETSC_OP_SKUS
        (EAN, Product_dsc, selected_category_id, detection_category_id, status, creation_date)
      OUTPUT INSERTED.*
      VALUES
        (@ean, @productDsc, @selectedCat, @detectionCat, @status, GETDATE())
    `);
  return r.recordset[0];
};

const updateSku = async (skuId, partial) => {
  const pool = await getPool();
  const req = pool.request().input("skuId", sql.Int, skuId);
  const set = [];

  if (partial.productDsc !== undefined) {
    req.input("dsc", sql.VarChar(100), partial.productDsc ?? null);
    set.push("Product_dsc = @dsc");
  }
  if (partial.selectedCategoryId !== undefined) {
    req.input("selectedCat", sql.Int, partial.selectedCategoryId ?? null);
    set.push("selected_category_id = @selectedCat");
  }
  if (partial.detectionCategoryId !== undefined) {
    req.input("detectionCat", sql.Int, partial.detectionCategoryId ?? null);
    set.push("detection_category_id = @detectionCat");
  }
  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE RETSC_OP_SKUS SET ${set.join(", ")}
    OUTPUT INSERTED.*
    WHERE SKU_ID = @skuId
  `);
  return r.recordset[0] ?? null;
};

// ── RETSC_OP_ENTERPRISE_PRODUCT_SEG ─────────────────────────────────────────
// Link enterprise↔sku real (antes apuntaba a RETSC_OP_ENTERPRISE_SKUS, que no existe).
// No recibe categoría: esta tabla no tiene esas columnas — la categorización del
// SKU (selected_category_id/detection_category_id) ya se graba en RETSC_OP_SKUS
// vía insertSku/updateSku, a nivel global, no por-empresa.

const findEnterpriseSku = async (enterpriseId, skuId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("enterpriseId", sql.Int, enterpriseId)
    .input("skuId", sql.Int, skuId).query(`
      SELECT * FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG
      WHERE enterprise_id = @enterpriseId AND sku_id = @skuId
    `);
  return r.recordset[0] ?? null;
};

const insertEnterpriseSku = async (data) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("enterpriseId",       sql.Int,          data.enterpriseId)
    .input("skuId",               sql.Int,          data.skuId)
    .input("status",              sql.VarChar(20),  "ACTIVE")
    .input("brand",               sql.VarChar(50),  data.brand ?? null)
    .input("supplier",            sql.VarChar(50),  data.supplier ?? null)
    .input("clientCategory",      sql.VarChar(100), data.clientCategory ?? null)
    .input("clientSubcategory",   sql.VarChar(100), data.clientSubcategory ?? null)
    .input("volume",              sql.Decimal(18, 4), data.volume ?? null)
    .input("relevantFeature",     sql.VarChar(100), data.relevantFeature ?? null)
    .query(`
      INSERT INTO RETSC_OP_ENTERPRISE_PRODUCT_SEG
        (enterprise_id, sku_id, status, created_at,
         Brand, Supplier, client_category, client_subcategory, volume, Relevant_feature)
      OUTPUT INSERTED.*
      VALUES
        (@enterpriseId, @skuId, @status, GETDATE(),
         @brand, @supplier, @clientCategory, @clientSubcategory, @volume, @relevantFeature)
    `);
  return r.recordset[0];
};

// Resincroniza los datos del cliente (brand/categoría/volumen/etc.) en una
// recarga posterior del mismo SKU — antes de esto, una vez creada la fila
// enterprise-sku, nunca se actualizaba, dejando datos viejos/incorrectos
// pegados para siempre si el Excel se volvía a subir con datos corregidos.
const updateEnterpriseSku = async (segId, partial) => {
  const pool = await getPool();
  const req = pool.request().input("segId", sql.Int, segId);
  const set = ["updated_at = GETDATE()"];

  if (partial.brand               !== undefined) { req.input("brand",              sql.VarChar(50),   partial.brand);              set.push("Brand = @brand"); }
  if (partial.supplier            !== undefined) { req.input("supplier",           sql.VarChar(50),   partial.supplier);           set.push("Supplier = @supplier"); }
  if (partial.clientCategory      !== undefined) { req.input("clientCategory",     sql.VarChar(100),  partial.clientCategory);     set.push("client_category = @clientCategory"); }
  if (partial.clientSubcategory   !== undefined) { req.input("clientSubcategory",  sql.VarChar(100),  partial.clientSubcategory);  set.push("client_subcategory = @clientSubcategory"); }
  if (partial.volume              !== undefined) { req.input("volume",             sql.Decimal(18,4), partial.volume);             set.push("volume = @volume"); }
  if (partial.relevantFeature     !== undefined) { req.input("relevantFeature",    sql.VarChar(100),  partial.relevantFeature);    set.push("Relevant_feature = @relevantFeature"); }

  if (set.length === 1) return null; // nada más que el updated_at — no vale la pena el UPDATE

  const r = await req.query(`
    UPDATE RETSC_OP_ENTERPRISE_PRODUCT_SEG
    SET ${set.join(", ")}
    OUTPUT INSERTED.*
    WHERE seg_id = @segId
  `);
  return r.recordset[0] ?? null;
};

// ── RETSC_LOG_SKU_UPLOAD ───────────────────────────────────────────────────

const logSkuRow = async (data) => {
  const pool = await getPool();
  await pool
    .request()
    .input("enterpriseId", sql.Int, data.enterpriseId)
    .input("batchId", sql.UniqueIdentifier, data.batchId)
    .input("rowNumber", sql.Int, data.rowNumber)
    .input("ean", sql.VarChar(20), data.ean)
    .input("skuDescription", sql.VarChar(500), data.skuDescription ?? null)
    .input("selectedCatId", sql.Int, data.selectedCategoryId ?? null)
    .input("detectionCatId", sql.Int, data.detectionCategoryId ?? null)
    .input("processStatus", sql.VarChar(50), data.processStatus)
    .input("errorCode", sql.VarChar(100), data.errorCode ?? null)
    .input("errorMessage", sql.VarChar(1000), data.errorMessage ?? null).query(`
      INSERT INTO RETSC_LOG_SKU_UPLOAD
        (enterprise_id, upload_batch_id, row_number, ean, sku_description,
         selected_category_id, detection_category_id, process_status,
         error_code, error_message, created_at)
      VALUES
        (@enterpriseId, @batchId, @rowNumber, @ean, @skuDescription,
         @selectedCatId, @detectionCatId, @processStatus,
         @errorCode, @errorMessage, GETDATE())
    `);
};

// Expresión de agrupación para GET /api/products/global (menú por rol 2026-07-25, ítem
// "Productos" de ADMIN_DTC). No hay FK que distinga "producto" de "SKU" — RETSC_OP_PRODUCTS
// fue eliminada (commit b775f86) y hoy cada fila de RETSC_OP_SKUS ES un EAN individual, no
// necesariamente un "producto" en el sentido de catálogo. Jefatura pidió que "Productos" sea
// una vista distinta de "SKUs globales" (GET /api/skus/global, una fila por EAN) — el criterio
// elegido para agrupar es (Product_dsc, detection_category_id): dos EANs con la MISMA
// descripción Y la MISMA categoría global se muestran como un solo producto (ej. un rediseño
// de empaque que reemplaza el EAN pero mantiene nombre/categoría); dos EANs con la misma
// descripción mientras el nombre coincide por texto pero la categoría difiere NO se
// mezclan (evita colapsar dos productos distintos que casualmente comparten texto
// descriptivo). Con los datos reales de hoy (3 SKUs, cada uno con Product_dsc distinto —
// "Fideos"/"Lasaña"/"Tallarín", verificado 2026-07-26) esta agrupación no colapsa nada
// todavía; el criterio queda listo para cuando sí haya EANs repetidos bajo un mismo producto.
// Product_dsc es NULLABLE en el esquema real (aunque hoy no hay ninguna fila NULL) — un GROUP
// BY directo sobre Product_dsc mezclaría TODAS las filas sin descripción en un solo grupo
// falso; PRODUCT_GROUP_KEY_EXPR usa el propio SKU_ID como fallback para que cada SKU sin
// descripción quede en su propio grupo en vez de fusionarse con otros.
const PRODUCT_GROUP_KEY_EXPR = `CASE WHEN Product_dsc IS NULL THEN CONCAT('__nodesc_', SKU_ID) ELSE Product_dsc END`;

function buildGlobalProductFilters(req, filters) {
  let whereExtra = '';

  // Solo por descripción — a nivel agrupado no hay un EAN único por fila (puede haber
  // más de uno detrás de un mismo producto), a diferencia de listGlobal (SKUs).
  if (filters.search) {
    req.input('search', sql.NVarChar(200), `%${filters.search}%`);
    whereExtra += ' AND Product_dsc LIKE @search';
  }

  return whereExtra;
}

// GET /api/products/global — catálogo global derivado de RETSC_OP_SKUS, SIN ninguna
// columna de RETSC_OP_ENTERPRISE_PRODUCT_SEG (esta vista no lleva marca/segmento/categoría
// comercial de cliente — eso es exactamente lo que la distingue de GET /api/products,
// que sí está scopeado por empresa vía esa tabla).
const listGlobalProducts = async (filters = {}) => {
  const pool = await getPool();
  const page   = Math.max(1, Number(filters.page)  || 1);
  const limit  = Math.max(1, Number(filters.limit) || 50);
  const offset = (page - 1) * limit;

  const countReq = pool.request();
  const whereExtraCount = buildGlobalProductFilters(countReq, filters);
  const countResult = await countReq.query(`
    SELECT COUNT(*) AS total FROM (
      SELECT ${PRODUCT_GROUP_KEY_EXPR} AS group_key
      FROM RETSC_OP_SKUS
      WHERE 1=1
      ${whereExtraCount}
      GROUP BY ${PRODUCT_GROUP_KEY_EXPR}, detection_category_id
    ) AS grouped
  `);
  const total = countResult.recordset[0]?.total ?? 0;

  const listReq = pool.request()
    .input('offset', sql.Int, offset)
    .input('limit',  sql.Int, limit);
  const whereExtraList = buildGlobalProductFilters(listReq, filters);
  const r = await listReq.query(`
    SELECT
      MIN(SKU_ID)          AS sample_sku_id,
      MAX(Product_dsc)     AS Product_dsc,
      detection_category_id,
      COUNT(*)             AS sku_count,
      CASE WHEN SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) > 0
           THEN 'ACTIVE' ELSE MAX(status) END AS status,
      MAX(image_url)       AS image_url,
      MAX(image_status)    AS image_status,
      MIN(creation_date)   AS creation_date
    FROM RETSC_OP_SKUS
    WHERE 1=1
    ${whereExtraList}
    GROUP BY ${PRODUCT_GROUP_KEY_EXPR}, detection_category_id
    ORDER BY MAX(Product_dsc) ASC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  `);
  return { rows: r.recordset, total };
};

module.exports = {
  findSkuByEan,
  insertSku,
  updateSku,
  findEnterpriseSku,
  insertEnterpriseSku,
  updateEnterpriseSku,
  logSkuRow,
  listGlobal,
  listGlobalProducts,
};
