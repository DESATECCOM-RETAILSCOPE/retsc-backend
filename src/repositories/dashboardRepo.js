// Métricas reales para el dashboard (Issue B7, 2026-07-26) — reemplaza los datos mock
// que usaba el frontend. Cada función acepta { enterpriseId } — con un enterpriseId
// numérico, escopea a esa empresa (ADMIN/GERENCIA); con enterpriseId null/undefined,
// cuenta GLOBAL sobre toda la plataforma (ADMIN_DTC). La decisión de qué scope usar vive
// en dashboardService.js, no acá — este repo solo sabe ejecutar la query en el scope que
// le pidan.
//
// Fuentes elegidas (documentadas porque ninguna es 100% obvia):
//   - productCards      → RETSC_OP_ENTERPRISE_PRODUCT_SEG (por empresa) /
//                          RETSC_OP_SKUS (global) — mismo criterio de "producto cargado"
//                          que ya usa productRepo.listByEnterprise.
//   - productPhotos     → RETSC_AI_SKU_FEATURES (una fila = una imagen de SKU subida),
//                          join a RETSC_OP_ENTERPRISE_PRODUCT_SEG para el scope por empresa.
//   - activeAssortments → RETSC_OP_ASSORTMENT. Tabla real (columnas: assortment_id,
//                          enterprise_id, category_id, level_type, level_id, is_mandatory,
//                          priority, sku_id, created_at — verificada 2026-07-26 con
//                          INFORMATION_SCHEMA), pero NO tiene columna status/is_active, así
//                          que "activo" acá es "toda fila existente" (no hay soft-delete
//                          modelado). La tabla está VACÍA hoy (0 filas en producción) —
//                          por eso este número da 0 legítimamente, no es un placeholder
//                          hardcodeado: es una cuenta real sobre una tabla real sin datos
//                          todavía, no un mock.
//   - analysesDone      → RETSC_OP_SKUS.image_status = 'COGNITIVELY_PROCESSED' (marca que
//                          el pipeline de OCR/embeddings ya terminó de analizar la imagen
//                          del SKU — ver queueService.js / RETSC_LOG_IMAGE_UPLOAD). Se
//                          eligió esto y NO RETSC_EX_SHELFPHOTO_DETECTION (que también
//                          existe y a primera vista suena a "análisis") porque esa tabla
//                          es del pipeline de detección en fotos de góndola para
//                          GERENCIA/KPIs — está vacía y sin ningún código en este repo que
//                          la lea o escriba todavía (verificado 2026-07-26); usarla daría
//                          0 siempre sin ninguna garantía de que sea la métrica correcta
//                          una vez ese pipeline exista. image_status sí tiene datos reales
//                          hoy y está directamente ligado al pipeline de SKU images ya
//                          activo en este repo.

const { getPool, sql } = require('../config/db');

const countProductCards = async ({ enterpriseId } = {}) => {
  const pool = await getPool();
  if (enterpriseId != null) {
    const r = await pool.request().input('enterpriseId', sql.Int, enterpriseId).query(`
      SELECT COUNT(*) AS n FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG
      WHERE enterprise_id = @enterpriseId AND status = 'ACTIVE'
    `);
    return r.recordset[0].n;
  }
  const r = await pool.request().query(`SELECT COUNT(*) AS n FROM RETSC_OP_SKUS WHERE status = 'ACTIVE'`);
  return r.recordset[0].n;
};

const countProductPhotos = async ({ enterpriseId } = {}) => {
  const pool = await getPool();
  if (enterpriseId != null) {
    const r = await pool.request().input('enterpriseId', sql.Int, enterpriseId).query(`
      SELECT COUNT(*) AS n
      FROM RETSC_AI_SKU_FEATURES f
      JOIN RETSC_OP_ENTERPRISE_PRODUCT_SEG seg ON seg.sku_id = f.sku_id
      WHERE seg.enterprise_id = @enterpriseId AND seg.status = 'ACTIVE'
    `);
    return r.recordset[0].n;
  }
  const r = await pool.request().query(`SELECT COUNT(*) AS n FROM RETSC_AI_SKU_FEATURES`);
  return r.recordset[0].n;
};

const countActiveAssortments = async ({ enterpriseId } = {}) => {
  const pool = await getPool();
  if (enterpriseId != null) {
    const r = await pool.request().input('enterpriseId', sql.Int, enterpriseId).query(`
      SELECT COUNT(*) AS n FROM RETSC_OP_ASSORTMENT WHERE enterprise_id = @enterpriseId
    `);
    return r.recordset[0].n;
  }
  const r = await pool.request().query(`SELECT COUNT(*) AS n FROM RETSC_OP_ASSORTMENT`);
  return r.recordset[0].n;
};

const countAnalysesDone = async ({ enterpriseId } = {}) => {
  const pool = await getPool();
  if (enterpriseId != null) {
    const r = await pool.request().input('enterpriseId', sql.Int, enterpriseId).query(`
      SELECT COUNT(*) AS n
      FROM RETSC_OP_SKUS sk
      JOIN RETSC_OP_ENTERPRISE_PRODUCT_SEG seg ON seg.sku_id = sk.SKU_ID
      WHERE seg.enterprise_id = @enterpriseId AND seg.status = 'ACTIVE'
        AND sk.image_status = 'COGNITIVELY_PROCESSED'
    `);
    return r.recordset[0].n;
  }
  const r = await pool.request().query(`
    SELECT COUNT(*) AS n FROM RETSC_OP_SKUS WHERE image_status = 'COGNITIVELY_PROCESSED'
  `);
  return r.recordset[0].n;
};

module.exports = { countProductCards, countProductPhotos, countActiveAssortments, countAnalysesDone };
