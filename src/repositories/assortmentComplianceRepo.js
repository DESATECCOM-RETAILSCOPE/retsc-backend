// Repositorio para RETSC_EX_ASSORTMENT_COMPLIANCE / RETSC_EX_ASSORTMENT_COMPLIANCE_SHARE —
// reporte "Cumplimiento de Surtido" (María, 2026-09). Ambas tablas YA EXISTEN en la BD real
// (confirmado vía INFORMATION_SCHEMA, 2026-09-13) — no las crea ninguna migración de este
// repo, así que se asume que las gestiona el equipo de BD por fuera.
//
// Distinto de assortmentRepo.js (listMissingMandatory) — ese quedó ROTO contra el esquema
// real (usa a.category_id/a.is_mandatory, columnas que no existen en la RETSC_OP_ASSORTMENT
// real: enterprise_id, sku_id, Supermarketchain_id, Format, status, fecha_activacion,
// fecha_inactivacion, es_prioritario) y sigue sin arreglarse — no lo toca este archivo.
//
// Se calcula BAJO DEMANDA (cuando el mobile pide el ResultsScreen de una visita/categoría),
// no al cerrar la visita — cada cálculo INSERTA una fila nueva (no hace upsert), la tabla
// está pensada para guardar histórico (columna calculado_en, KPIs históricos).
//
// Query base: la versión FINAL del script de María (no la primera versión con
// sku.category_id, que no existe — ni la segunda con en_exceso de una sola columna, que no
// coincide con el esquema real de RETSC_EX_ASSORTMENT_COMPLIANCE, que sí tiene las dos
// columnas separadas en_exceso_fuera_surtido/en_exceso_no_autorizado).
//
// ⚠ CAMBIO respecto al script original (2026-09-13, verificado contra datos reales): María
// usaba sku.selected_category_id para el join de "categoría", pero ESA columna es un
// concepto de categoría distinto al que usa el resto de la app (captura de fotos, modelo de
// Custom Vision, detección) — para Enterprise_id=35/category=2 (Desodorantes) las 83 filas
// de RETSC_OP_ASSORTMENT tenían selected_category_id=1 (uniforme, sin relación) pero
// detection_category_id=2 (coincide). Cambiado a sku.detection_category_id en las 3 queries
// de este archivo — es el mismo @categoryId que ya usa toda la app (getSmartCategoriesRequest
// en el mobile, RETSC_EX_SHELFPHOTO.CATEGORY_ID, RETSC_AI_DETECTION_MODELS.category_id).

const { getPool, sql } = require('../config/db');

const TABLE           = 'RETSC_EX_ASSORTMENT_COMPLIANCE';
const SHARE_TABLE     = 'RETSC_EX_ASSORTMENT_COMPLIANCE_SHARE';

// Calcula el cumplimiento de una visita/categoría y lo persiste — INSERT, no upsert.
// Todos los parámetros ya resueltos por el caller (assortmentComplianceService.js):
//   visitId, enterpriseId, categoryId (selected_category_id de RETSC_OP_SKUS),
//   supermarketchainId, format (de RETSC_OP_RETAILER de la visita),
//   enterpriseSupplierName (RETSC_OP_ENTERPRISE.supplier_name, migración 011 — puede ser
//   null si no está cargado para este enterprise: en ese caso en_exceso_fuera_surtido/
//   en_exceso_no_autorizado quedan ambos en 0, ver comentario en el WITH de abajo).
//
// Devuelve la fila insertada completa (con compliance_id).
const calculateAndSave = async ({
  visitId, enterpriseId, categoryId, supermarketchainId, format, enterpriseSupplierName,
}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('visitId',       sql.Int,          visitId)
    .input('enterpriseId',  sql.Int,          enterpriseId)
    .input('category',      sql.Int,          categoryId)
    .input('smktChainId',   sql.Int,          supermarketchainId)
    .input('format',        sql.VarChar(50),  format)
    .input('supplierName',  sql.VarChar(100), enterpriseSupplierName ?? null)
    .query(`
      ;WITH propios AS (
        -- Cualquier SKU que en algún momento haya sido parte del assortment de este
        -- enterprise (para cualquier Supermarketchain/Format) — universo de "SKUs que son
        -- míos", sin filtrar por vigencia/formato de tienda.
        SELECT DISTINCT sku_id FROM RETSC_OP_ASSORTMENT WHERE enterprise_id = @enterpriseId
      ),
      autorizados AS (
        SELECT a.sku_id, a.es_prioritario
        FROM RETSC_OP_ASSORTMENT a
        INNER JOIN RETSC_OP_SKUS sku ON sku.SKU_ID = a.sku_id
        WHERE a.enterprise_id = @enterpriseId AND a.status = 'ACTIVO'
          AND a.Supermarketchain_id = @smktChainId AND a.Format = @format
          AND sku.detection_category_id = @category
      ),
      detectados AS (
        SELECT DISTINCT d.Sku_id AS sku_id
        FROM RETSC_EX_SHELFPHOTO_DETECTION d
        INNER JOIN RETSC_EX_SHELFPHOTO p ON p.Photo_id = d.Photo_id
        WHERE p.Visit_id = @visitId AND d.Sku_id IS NOT NULL
          AND d.Sku_id IN (SELECT sku_id FROM autorizados)
      ),
      detectados_visita AS (
        SELECT DISTINCT d.Sku_id AS sku_id
        FROM RETSC_EX_SHELFPHOTO_DETECTION d
        INNER JOIN RETSC_EX_SHELFPHOTO p ON p.Photo_id = d.Photo_id
        WHERE p.Visit_id = @visitId AND d.Sku_id IS NOT NULL
      ),
      estado_aqui AS (
        SELECT sku_id, status
        FROM RETSC_OP_ASSORTMENT
        WHERE enterprise_id = @enterpriseId AND Supermarketchain_id = @smktChainId
          AND Format = @format
      ),
      fabricante_propio AS (
        -- Vacío si @supplierName es NULL (enterprise sin migración 011 cargada) — en ese
        -- caso ningún SKU detectado cae en FUERA_DE_SURTIDO, así que exceso queda todo
        -- clasificado como NO_AUTORIZADO (subestima fuera_surtido, no sobreestima nada).
        SELECT DISTINCT s.sku_id
        FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG s
        WHERE s.enterprise_id = @enterpriseId AND @supplierName IS NOT NULL
          AND s.Supplier = @supplierName
      ),
      exceso AS (
        SELECT dv.sku_id,
          CASE WHEN dv.sku_id IN (SELECT sku_id FROM propios) THEN 'FUERA_DE_SURTIDO' ELSE 'NO_AUTORIZADO' END AS motivo
        FROM detectados_visita dv
        LEFT JOIN estado_aqui e ON e.sku_id = dv.sku_id
        WHERE (dv.sku_id IN (SELECT sku_id FROM propios) AND ISNULL(e.status, 'INACTIVO') NOT IN ('ACTIVO', 'DESCONTINUADO'))
           OR (dv.sku_id IN (SELECT sku_id FROM fabricante_propio) AND dv.sku_id NOT IN (SELECT sku_id FROM propios))
      )
      INSERT INTO ${TABLE}
        (visit_id, enterprise_id, category, Supermarketchain_id, Format,
         productos_esperados, productos_detectados, faltantes,
         en_exceso_fuera_surtido, en_exceso_no_autorizado,
         prioritarios_faltantes, cumplimiento_pct, calculado_en)
      OUTPUT INSERTED.*
      SELECT
        @visitId, @enterpriseId, @category, @smktChainId, @format,
        (SELECT COUNT(*) FROM autorizados),
        (SELECT COUNT(*) FROM detectados),
        (SELECT COUNT(*) FROM autorizados a WHERE a.sku_id NOT IN (SELECT sku_id FROM detectados)),
        (SELECT COUNT(*) FROM exceso WHERE motivo = 'FUERA_DE_SURTIDO'),
        (SELECT COUNT(*) FROM exceso WHERE motivo = 'NO_AUTORIZADO'),
        (SELECT COUNT(*) FROM autorizados a WHERE a.es_prioritario = 1 AND a.sku_id NOT IN (SELECT sku_id FROM detectados)),
        CAST((SELECT COUNT(*) FROM detectados) * 100.0 / NULLIF((SELECT COUNT(*) FROM autorizados), 0) AS DECIMAL(5,1)),
        GETDATE()
    `);
  return r.recordset[0] ?? null;
};

// Desglose "Composición en góndola" (por marca/fabricante/subcategoría/presentación) para
// TODO lo detectado en la visita para esta categoría (no solo lo autorizado) — persiste una
// fila por (dimension, valor).
const saveShare = async (complianceId, { visitId, categoryId, enterpriseId }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('complianceId', sql.Int, complianceId)
    .input('visitId',      sql.Int, visitId)
    .input('category',     sql.Int, categoryId)
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`
      ;WITH detectados_todos AS (
        SELECT DISTINCT d.Sku_id AS sku_id
        FROM RETSC_EX_SHELFPHOTO_DETECTION d
        INNER JOIN RETSC_EX_SHELFPHOTO p ON p.Photo_id = d.Photo_id
        WHERE p.Visit_id = @visitId AND p.CATEGORY_ID = @category AND d.Sku_id IS NOT NULL
      ),
      seg AS (
        SELECT s.Brand, s.Supplier, s.client_subcategory, s.Relevant_feature
        FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG s
        WHERE s.enterprise_id = @enterpriseId AND s.sku_id IN (SELECT sku_id FROM detectados_todos)
      )
      INSERT INTO ${SHARE_TABLE} (compliance_id, dimension, valor, cantidad)
      SELECT @complianceId, 'marca', Brand, COUNT(*) FROM seg GROUP BY Brand
      UNION ALL
      SELECT @complianceId, 'fabricante', Supplier, COUNT(*) FROM seg GROUP BY Supplier
      UNION ALL
      SELECT @complianceId, 'subcategoria', client_subcategory, COUNT(*) FROM seg GROUP BY client_subcategory
      UNION ALL
      SELECT @complianceId, 'presentacion', Relevant_feature, COUNT(*) FROM seg GROUP BY Relevant_feature
    `);
  return r.rowsAffected[0];
};

const getShareByComplianceId = async (complianceId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('complianceId', sql.Int, complianceId)
    .query(`SELECT dimension, valor, cantidad FROM ${SHARE_TABLE} WHERE compliance_id = @complianceId ORDER BY dimension, cantidad DESC`);
  return r.recordset;
};

// Detalle de productos faltantes (autorizados no detectados) con su nombre — para la lista
// "Detalle" del ResultsScreen. No viene en el script de María (que solo daba el COUNT) —
// mismos filtros que el CTE `autorizados`/`faltantes` de calculateAndSave, ampliado con
// Product_dsc/Brand para mostrar. Se recalcula en vez de leerse de la fila ya persistida
// porque esa fila solo guarda el conteo, no la lista.
const listFaltantes = async ({ enterpriseId, categoryId, supermarketchainId, format, visitId }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int,         enterpriseId)
    .input('category',     sql.Int,         categoryId)
    .input('smktChainId',  sql.Int,         supermarketchainId)
    .input('format',       sql.VarChar(50), format)
    .input('visitId',      sql.Int,         visitId)
    .query(`
      ;WITH autorizados AS (
        SELECT a.sku_id, a.es_prioritario
        FROM RETSC_OP_ASSORTMENT a
        INNER JOIN RETSC_OP_SKUS sku ON sku.SKU_ID = a.sku_id
        WHERE a.enterprise_id = @enterpriseId AND a.status = 'ACTIVO'
          AND a.Supermarketchain_id = @smktChainId AND a.Format = @format
          AND sku.detection_category_id = @category
      ),
      detectados AS (
        SELECT DISTINCT d.Sku_id AS sku_id
        FROM RETSC_EX_SHELFPHOTO_DETECTION d
        INNER JOIN RETSC_EX_SHELFPHOTO p ON p.Photo_id = d.Photo_id
        WHERE p.Visit_id = @visitId AND d.Sku_id IS NOT NULL
          AND d.Sku_id IN (SELECT sku_id FROM autorizados)
      )
      SELECT sku.SKU_ID AS sku_id, sku.Product_dsc, seg.Brand, a.es_prioritario
      FROM autorizados a
      JOIN RETSC_OP_SKUS sku ON sku.SKU_ID = a.sku_id
      LEFT JOIN RETSC_OP_ENTERPRISE_PRODUCT_SEG seg
        ON seg.sku_id = a.sku_id AND seg.enterprise_id = @enterpriseId
      WHERE a.sku_id NOT IN (SELECT sku_id FROM detectados)
      ORDER BY a.es_prioritario DESC, sku.Product_dsc
    `);
  return r.recordset;
};

// Detalle de productos en exceso (detectados pero no autorizados) con su nombre y motivo —
// mismo criterio que el CTE `exceso` de calculateAndSave, ampliado con Product_dsc/Brand.
const listEnExceso = async ({ enterpriseId, categoryId, supermarketchainId, format, visitId, enterpriseSupplierName }) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId',  sql.Int,          enterpriseId)
    .input('category',      sql.Int,          categoryId)
    .input('smktChainId',   sql.Int,          supermarketchainId)
    .input('format',        sql.VarChar(50),  format)
    .input('visitId',       sql.Int,          visitId)
    .input('supplierName',  sql.VarChar(100), enterpriseSupplierName ?? null)
    .query(`
      ;WITH propios AS (
        SELECT DISTINCT sku_id FROM RETSC_OP_ASSORTMENT WHERE enterprise_id = @enterpriseId
      ),
      autorizados AS (
        SELECT a.sku_id
        FROM RETSC_OP_ASSORTMENT a
        INNER JOIN RETSC_OP_SKUS sku ON sku.SKU_ID = a.sku_id
        WHERE a.enterprise_id = @enterpriseId AND a.status = 'ACTIVO'
          AND a.Supermarketchain_id = @smktChainId AND a.Format = @format
          AND sku.detection_category_id = @category
      ),
      detectados_visita AS (
        SELECT DISTINCT d.Sku_id AS sku_id
        FROM RETSC_EX_SHELFPHOTO_DETECTION d
        INNER JOIN RETSC_EX_SHELFPHOTO p ON p.Photo_id = d.Photo_id
        WHERE p.Visit_id = @visitId AND d.Sku_id IS NOT NULL
      ),
      estado_aqui AS (
        SELECT sku_id, status
        FROM RETSC_OP_ASSORTMENT
        WHERE enterprise_id = @enterpriseId AND Supermarketchain_id = @smktChainId AND Format = @format
      ),
      fabricante_propio AS (
        SELECT DISTINCT s.sku_id
        FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG s
        WHERE s.enterprise_id = @enterpriseId AND @supplierName IS NOT NULL AND s.Supplier = @supplierName
      )
      SELECT sku.SKU_ID AS sku_id, sku.Product_dsc, seg.Brand,
        CASE WHEN dv.sku_id IN (SELECT sku_id FROM propios) THEN 'FUERA_DE_SURTIDO' ELSE 'NO_AUTORIZADO' END AS motivo
      FROM detectados_visita dv
      JOIN RETSC_OP_SKUS sku ON sku.SKU_ID = dv.sku_id
      LEFT JOIN RETSC_OP_ENTERPRISE_PRODUCT_SEG seg ON seg.sku_id = dv.sku_id AND seg.enterprise_id = @enterpriseId
      LEFT JOIN estado_aqui e ON e.sku_id = dv.sku_id
      WHERE (dv.sku_id IN (SELECT sku_id FROM propios) AND ISNULL(e.status, 'INACTIVO') NOT IN ('ACTIVO', 'DESCONTINUADO'))
         OR (dv.sku_id IN (SELECT sku_id FROM fabricante_propio) AND dv.sku_id NOT IN (SELECT sku_id FROM propios))
      ORDER BY sku.Product_dsc
    `);
  return r.recordset;
};

const getLatestByVisitCategory = async (visitId, categoryId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('visitId',  sql.Int, visitId)
    .input('category', sql.Int, categoryId)
    .query(`
      SELECT TOP 1 * FROM ${TABLE}
      WHERE visit_id = @visitId AND category = @category
      ORDER BY compliance_id DESC
    `);
  return r.recordset[0] ?? null;
};

module.exports = {
  calculateAndSave,
  saveShare,
  getShareByComplianceId,
  listFaltantes,
  listEnExceso,
  getLatestByVisitCategory,
};
