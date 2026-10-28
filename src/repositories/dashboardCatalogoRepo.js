// Dashboard web (Parte B): catálogo de productos y cobertura de fotos.
// Lo usan el Resumen (KPIs) y la pantalla 3, Catálogo & Fotos.
//
// El catálogo es GLOBAL a propósito (la pantalla Catálogo dice "catálogo maestro
// global"): los totales cuentan todos los SKUs activos. La empresa solo define cuáles
// son "propios": los que alguna vez estuvieron en su surtido (anexo, query 5).
//
// Ajustes sobre el anexo, verificados en QA:
//   · Estado activo: 'ACTIVE' (B4, 26-oct-2026). El anexo usaba 'ACTIVO', que
//     devuelve 0 filas.
//   · Categoría: detection_category_id (categoría del árbol DTC, RETSC_OP_CATEGORIES).
//     El anexo usaba selected_category_id, que apunta a RETSC_OP_ENTERPRISE_CATEGORIES
//     (la categoría de la empresa que cargó el SKU): con el filtro category=2 daba 0
//     productos aunque hay 201 (verificación del 28-oct-2026). Es la misma columna que
//     usa productRepo para el filtro de categoría oficial.

const { getPool, sql } = require('../config/db');

const SKUS       = 'RETSC_OP_SKUS';
const ASSORTMENT = 'RETSC_OP_ASSORTMENT';
const ACTIVO     = 'ACTIVE';

async function request(f) {
  const pool = await getPool();
  return pool.request()
    .input('enterpriseId', sql.Int,         f.enterpriseId)
    .input('category',     sql.Int,         f.category)
    .input('activo',       sql.VarChar(20), ACTIVO);
}

// Productos registrados, propios y competencia (anexo 5).
async function productos(f) {
  const r = await (await request(f)).query(`
    ;WITH propios AS (
      SELECT DISTINCT sku_id FROM ${ASSORTMENT} WHERE enterprise_id = @enterpriseId
    )
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN p.sku_id IS NOT NULL THEN 1 ELSE 0 END) AS propios,
           SUM(CASE WHEN p.sku_id IS NULL     THEN 1 ELSE 0 END) AS competencia
    FROM ${SKUS} sku
    LEFT JOIN propios p ON p.sku_id = sku.SKU_ID
    WHERE sku.status = @activo
      AND (@category IS NULL OR sku.detection_category_id = @category);
  `);
  const row = r.recordset[0] ?? {};
  return {
    total:       Number(row.total) || 0,
    propios:     Number(row.propios) || 0,
    competencia: Number(row.competencia) || 0,
  };
}

// Cobertura de foto del catálogo vigente (anexo 6B).
async function coberturaFotos(f) {
  const r = await (await request(f)).query(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN NULLIF(LTRIM(RTRIM(sku.image_url)), '') IS NOT NULL THEN 1 ELSE 0 END) AS con_foto
    FROM ${SKUS} sku
    WHERE sku.status = @activo
      AND (@category IS NULL OR sku.detection_category_id = @category);
  `);
  const row = r.recordset[0] ?? {};
  const total = Number(row.total) || 0;
  const conFoto = Number(row.con_foto) || 0;
  return { total, con_foto: conFoto, sin_foto: total - conFoto };
}

module.exports = { productos, coberturaFotos, ACTIVO };
