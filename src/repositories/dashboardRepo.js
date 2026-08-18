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

const SNAPSHOT_TABLE = 'RETSC_LOG_DASHBOARD_SNAPSHOTS';

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

// ─── Snapshots diarios (para tendencias) ────────────────────────────────────
//
// RETSC_LOG_DASHBOARD_SNAPSHOTS (migración 008, migrations/008_create_dashboard_snapshots.sql)
// — igual que la migración 006, se corre manualmente vía SSMS, no desde Node (convención de
// este repo). Mientras nadie la corra, esta tabla no existe todavía en producción: todas las
// funciones de esta sección atrapan el error ("Invalid object name") y devuelven un valor
// neutro en vez de romper GET /api/dashboard — el resto del dashboard (los 4 conteos,
// productsByCategory, recentActivity) no depende de esto y debe seguir funcionando igual.
//
// No hay cron en este repo: el "historial" se arma solo con el uso normal — cada request a
// GET /api/dashboard llama a upsertSnapshotToday() con los números que ya calculó en esa misma
// request, así que la fila de HOY siempre queda al día sin un job aparte.

function isMissingTableError(err) {
  return /Invalid object name/i.test(err.message || '');
}

// Upsert de la fila de HOY para este scope. Nunca lanza — un fallo acá (tabla no existe
// todavía, o cualquier otro problema) no debe tirar abajo el resto del dashboard.
const upsertSnapshotToday = async ({
  enterpriseId,
  productCards,
  productPhotos,
  activeAssortments,
  analysesDone,
  avgModelPrecisionPct,
}) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('enterpriseId',   sql.Int,          enterpriseId ?? null)
      .input('productCards',   sql.Int,          productCards)
      .input('productPhotos',  sql.Int,          productPhotos)
      .input('activeAssortments', sql.Int,       activeAssortments)
      .input('analysesDone',   sql.Int,          analysesDone)
      .input('avgPrecision',   sql.Decimal(5,2), avgModelPrecisionPct ?? null)
      .query(`
        MERGE ${SNAPSHOT_TABLE} AS target
        USING (SELECT CAST(GETDATE() AS DATE) AS snapshot_date) AS src
          ON target.snapshot_date = src.snapshot_date
          AND (
            (target.scope_enterprise_id = @enterpriseId)
            OR (target.scope_enterprise_id IS NULL AND @enterpriseId IS NULL)
          )
        WHEN MATCHED THEN
          UPDATE SET product_cards = @productCards,
                     product_photos = @productPhotos,
                     active_assortments = @activeAssortments,
                     analyses_done = @analysesDone,
                     avg_model_precision_pct = @avgPrecision,
                     updated_at = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (snapshot_date, scope_enterprise_id, product_cards, product_photos,
                  active_assortments, analyses_done, avg_model_precision_pct, created_at, updated_at)
          VALUES (src.snapshot_date, @enterpriseId, @productCards, @productPhotos,
                  @activeAssortments, @analysesDone, @avgPrecision, GETDATE(), GETDATE());
      `);
  } catch (err) {
    if (isMissingTableError(err)) {
      console.warn('[dashboard] RETSC_LOG_DASHBOARD_SNAPSHOTS no existe todavía (migración 008 no aplicada) — se omite el snapshot de hoy.');
    } else {
      console.error('[dashboard] no se pudo guardar el snapshot de hoy:', err.message);
    }
  }
};

// Últimos hasta `limit` snapshots de este scope, ordenados de más viejo a más nuevo
// (incluye el de hoy, recién escrito por upsertSnapshotToday en la misma request).
// [] si la tabla no existe todavía o no hay ningún snapshot.
const getSnapshotSeries = async ({ enterpriseId, limit = 8 } = {}) => {
  try {
    const pool = await getPool();
    const scopeClause = enterpriseId != null ? 'scope_enterprise_id = @enterpriseId' : 'scope_enterprise_id IS NULL';
    const req = pool.request().input('limit', sql.Int, limit);
    if (enterpriseId != null) req.input('enterpriseId', sql.Int, enterpriseId);
    const r = await req.query(`
      SELECT TOP (@limit) *
      FROM ${SNAPSHOT_TABLE}
      WHERE ${scopeClause}
      ORDER BY snapshot_date DESC
    `);
    return r.recordset.reverse(); // más viejo primero
  } catch (err) {
    if (!isMissingTableError(err)) console.error('[dashboard] error leyendo snapshots:', err.message);
    return [];
  }
};

// El snapshot más cercano a `cutoffDate` sin pasarse (el más nuevo <= cutoff); si no hay
// ninguno tan viejo, el snapshot más viejo disponible (estrictamente anterior a hoy). null si
// no hay ningún snapshot previo a hoy, o si la tabla no existe todavía.
const getReferenceSnapshot = async ({ enterpriseId, cutoffDate } = {}) => {
  try {
    const pool = await getPool();
    const scopeClause = enterpriseId != null ? 'scope_enterprise_id = @enterpriseId' : 'scope_enterprise_id IS NULL';

    const nearCutoffReq = pool.request().input('cutoff', sql.Date, cutoffDate);
    if (enterpriseId != null) nearCutoffReq.input('enterpriseId', sql.Int, enterpriseId);
    const nearCutoff = await nearCutoffReq.query(`
      SELECT TOP 1 * FROM ${SNAPSHOT_TABLE}
      WHERE ${scopeClause} AND snapshot_date <= @cutoff
      ORDER BY snapshot_date DESC
    `);
    if (nearCutoff.recordset[0]) return nearCutoff.recordset[0];

    const oldestReq = pool.request();
    if (enterpriseId != null) oldestReq.input('enterpriseId', sql.Int, enterpriseId);
    const oldest = await oldestReq.query(`
      SELECT TOP 1 * FROM ${SNAPSHOT_TABLE}
      WHERE ${scopeClause} AND snapshot_date < CAST(GETDATE() AS DATE)
      ORDER BY snapshot_date ASC
    `);
    return oldest.recordset[0] ?? null;
  } catch (err) {
    if (!isMissingTableError(err)) console.error('[dashboard] error leyendo snapshot de referencia:', err.message);
    return null;
  }
};

// ─── Desglose por categoría (Issue B7 follow-up) ────────────────────────────
// Mismo criterio de "producto" que countProductCards, agrupado por detection_category_id
// en vez de contar el total. Todas las categorías con al menos 1 producto (un GROUP BY ya
// garantiza eso — no hace falta HAVING COUNT(*)>0 aparte). SKUs sin categoría asignada
// (detection_category_id NULL) se agrupan bajo "Sin categoría" en vez de perderse del total.
const getProductsByCategory = async ({ enterpriseId } = {}) => {
  const pool = await getPool();
  if (enterpriseId != null) {
    const r = await pool.request().input('enterpriseId', sql.Int, enterpriseId).query(`
      SELECT sk.detection_category_id AS categoryId,
             ISNULL(cat.Category_dsc, 'Sin categoría') AS categoryDsc,
             COUNT(*) AS count
      FROM RETSC_OP_ENTERPRISE_PRODUCT_SEG seg
      JOIN RETSC_OP_SKUS sk ON sk.SKU_ID = seg.sku_id
      LEFT JOIN RETSC_OP_CATEGORIES cat ON cat.Category_id = sk.detection_category_id
      WHERE seg.enterprise_id = @enterpriseId AND seg.status = 'ACTIVE'
      GROUP BY sk.detection_category_id, cat.Category_dsc
      ORDER BY count DESC
    `);
    return r.recordset;
  }
  const r = await pool.request().query(`
    SELECT sk.detection_category_id AS categoryId,
           ISNULL(cat.Category_dsc, 'Sin categoría') AS categoryDsc,
           COUNT(*) AS count
    FROM RETSC_OP_SKUS sk
    LEFT JOIN RETSC_OP_CATEGORIES cat ON cat.Category_id = sk.detection_category_id
    WHERE sk.status = 'ACTIVE'
    GROUP BY sk.detection_category_id, cat.Category_dsc
    ORDER BY count DESC
  `);
  return r.recordset;
};

// ─── Precisión del modelo IA (Issue B7 follow-up, depende de migración 006) ─
// precision_score/recall_score/mean_ap en RETSC_AI_DETECTION_MODELS solo existen si se aplicó
// la migración 006 — verificada como NO aplicada (ver CLAUDE.md, sección de entrenamiento).
// NO se aplica esa migración desde acá — se coordinó aparte, explícitamente, no tocarla sin
// aviso. Mientras tanto esta función atrapa el "Invalid column name" y devuelve null: el
// panel existe en la respuesta pero sin datos, no se omite el campo entero.
//
// Scope por empresa: RETSC_AI_DETECTION_MODELS no tiene enterprise_id (los modelos son por
// categoría DTC, compartidos entre empresas) — para ADMIN/GERENCIA se filtra por las
// categorías smart YA RESUELTAS para esa empresa (mismo join que
// enterpriseCategoryRepo.listSmartForEnterprise), no por una relación directa que no existe.
//
// NOTA (docs/BUG-is_active-no-unico.md): puede haber más de una fila is_active=1 para la
// misma categoría — el promedio de acá puede estar sesgado por ese bug ya conocido y sin
// corregir. No se arregla en este cambio.
const getModelPrecisionAvg = async ({ enterpriseId } = {}) => {
  try {
    const pool = await getPool();
    if (enterpriseId != null) {
      const r = await pool.request().input('enterpriseId', sql.Int, enterpriseId).query(`
        SELECT AVG(m.precision_score) AS avgPrecision
        FROM RETSC_AI_DETECTION_MODELS m
        WHERE m.is_active = 1 AND m.precision_score IS NOT NULL
          AND m.category_id IN (
            SELECT DISTINCT ISNULL(ec.resolved_category_id, ec.selected_category_id)
            FROM RETSC_OP_ENTERPRISE_CATEGORIES ec
            WHERE ec.enterprise_id = @enterpriseId AND ec.status = 'ACTIVE'
          )
      `);
      return r.recordset[0].avgPrecision ?? null;
    }
    const r = await pool.request().query(`
      SELECT AVG(precision_score) AS avgPrecision
      FROM RETSC_AI_DETECTION_MODELS
      WHERE is_active = 1 AND precision_score IS NOT NULL
    `);
    return r.recordset[0].avgPrecision ?? null;
  } catch (err) {
    if (!/Invalid column name/i.test(err.message || '')) {
      console.error('[dashboard] error inesperado leyendo precisión de modelo:', err.message);
    }
    return null;
  }
};

// ─── Actividad reciente (Issue B7 follow-up) ────────────────────────────────
// 5 fuentes independientes, cada una acotada a TOP 10 y ordenada por su propio timestamp;
// se combinan, ordenan y recortan a 10 en dashboardService.js (más simple y más seguro que un
// UNION SQL de columnas heterogéneas con texto ya formateado).
//
// Nombres de columna verificados 2026-07-26 contra el esquema REAL post-split (Issue B1):
// photo_reviewed_at NO existe más — el estado de aprobación y su fecha viven en
// RETSC_AI_TRAINING_PHOTOS.reviewed_at, no en la tabla de anotaciones.
//
// Scope por empresa: RETSC_LOG_JOBS y RETSC_OP_ASSORTMENT tienen enterprise_id directo.
// RETSC_AI_TRAINING_PHOTOS tiene uploaded_by_enterprise_id, pero las fotos de góndola son
// GLOBALES por diseño (shelfPhotoUploadService.js: "La foto es GLOBAL: no pertenece a ningún
// enterprise") — hoy esa columna es NULL casi siempre, así que en la práctica
// SHELF_PHOTO_UPLOADED/PHOTO_APPROVED salen vacíos para un ADMIN normal; es el comportamiento
// correcto dado el modelo de datos actual, no un bug. RETSC_AI_DETECTION_MODELS tampoco tiene
// enterprise_id — se filtra por las categorías smart resueltas de la empresa, mismo criterio
// que getModelPrecisionAvg.
const getRecentActivitySources = async ({ enterpriseId } = {}) => {
  const pool = await getPool();

  const jobsReq = pool.request();
  if (enterpriseId != null) jobsReq.input('enterpriseId', sql.Int, enterpriseId);
  const jobs = (await jobsReq.query(`
    SELECT TOP 10 total_files, created_at
    FROM RETSC_LOG_JOBS
    WHERE job_type = 'SKU_IMAGE_UPLOAD'
      ${enterpriseId != null ? 'AND enterprise_id = @enterpriseId' : ''}
    ORDER BY created_at DESC
  `)).recordset.map(r => ({
    type: 'SKU_IMAGES_UPLOADED',
    title: `Se cargaron ${r.total_files ?? 0} imágenes`,
    meta: null,
    occurredAt: r.created_at,
  }));

  const assortReq = pool.request();
  if (enterpriseId != null) assortReq.input('enterpriseId', sql.Int, enterpriseId);
  const assortments = (await assortReq.query(`
    SELECT TOP 10 a.created_at, cat.Category_dsc
    FROM RETSC_OP_ASSORTMENT a
    LEFT JOIN RETSC_OP_CATEGORIES cat ON cat.Category_id = a.category_id
    WHERE 1 = 1 ${enterpriseId != null ? 'AND a.enterprise_id = @enterpriseId' : ''}
    ORDER BY a.created_at DESC
  `)).recordset.map(r => ({
    type: 'ASSORTMENT_UPDATED',
    title: 'Surtido actualizado',
    meta: r.Category_dsc ? `Categoría: ${r.Category_dsc}` : null,
    occurredAt: r.created_at,
  }));

  const shelfReq = pool.request();
  if (enterpriseId != null) shelfReq.input('enterpriseId', sql.Int, enterpriseId);
  const shelfPhotos = (await shelfReq.query(`
    SELECT TOP 10 p.created_at, p.canal, cat.Category_dsc
    FROM RETSC_AI_TRAINING_PHOTOS p
    LEFT JOIN RETSC_OP_CATEGORIES cat ON cat.Category_id = p.category_id
    WHERE 1 = 1 ${enterpriseId != null ? 'AND p.uploaded_by_enterprise_id = @enterpriseId' : ''}
    ORDER BY p.created_at DESC
  `)).recordset.map(r => ({
    type: 'SHELF_PHOTO_UPLOADED',
    title: 'Foto de góndola subida',
    meta: [r.Category_dsc, r.canal].filter(Boolean).join(' · ') || null,
    occurredAt: r.created_at,
  }));

  const approvedReq = pool.request();
  if (enterpriseId != null) approvedReq.input('enterpriseId', sql.Int, enterpriseId);
  const approvedPhotos = (await approvedReq.query(`
    SELECT TOP 10 p.reviewed_at, cat.Category_dsc
    FROM RETSC_AI_TRAINING_PHOTOS p
    LEFT JOIN RETSC_OP_CATEGORIES cat ON cat.Category_id = p.category_id
    WHERE p.photo_status = 'APROBADA' AND p.reviewed_at IS NOT NULL
      ${enterpriseId != null ? 'AND p.uploaded_by_enterprise_id = @enterpriseId' : ''}
    ORDER BY p.reviewed_at DESC
  `)).recordset.map(r => ({
    type: 'PHOTO_APPROVED',
    title: 'Foto de góndola aprobada',
    meta: r.Category_dsc ? `Categoría: ${r.Category_dsc}` : null,
    occurredAt: r.reviewed_at,
  }));

  const modelReq = pool.request();
  let modelWhere = 'm.trained_at IS NOT NULL';
  if (enterpriseId != null) {
    modelReq.input('enterpriseId', sql.Int, enterpriseId);
    modelWhere += ` AND m.category_id IN (
      SELECT DISTINCT ISNULL(ec.resolved_category_id, ec.selected_category_id)
      FROM RETSC_OP_ENTERPRISE_CATEGORIES ec
      WHERE ec.enterprise_id = @enterpriseId AND ec.status = 'ACTIVE'
    )`;
  }
  const models = (await modelReq.query(`
    SELECT TOP 10 m.trained_at, cat.Category_dsc
    FROM RETSC_AI_DETECTION_MODELS m
    LEFT JOIN RETSC_OP_CATEGORIES cat ON cat.Category_id = m.category_id
    WHERE ${modelWhere}
    ORDER BY m.trained_at DESC
  `)).recordset.map(r => ({
    type: 'MODEL_TRAINED',
    title: 'Modelo entrenado',
    meta: r.Category_dsc ? `Categoría: ${r.Category_dsc}` : null,
    occurredAt: r.trained_at,
  }));

  return [...jobs, ...assortments, ...shelfPhotos, ...approvedPhotos, ...models];
};

module.exports = {
  countProductCards,
  countProductPhotos,
  countActiveAssortments,
  countAnalysesDone,
  upsertSnapshotToday,
  getSnapshotSeries,
  getReferenceSnapshot,
  getProductsByCategory,
  getModelPrecisionAvg,
  getRecentActivitySources,
};
