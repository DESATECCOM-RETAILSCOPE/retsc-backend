// Ciclo 5 · B2 — Repositorio de planogramas: RETSC_OP_PLANOGRAM (encabezado) y catálogo de
// cadenas (RETSC_OP_SMKTCHAINS). El detalle (RETSC_OP_PLANOGRAMDET) se escribe en la Fase 8,
// al aprobar la revisión.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_PLANOGRAM';

// Columnas que devuelve la API (con nombres legibles de categoría / cadena / tienda).
const SELECT_WITH_NAMES = `
  SELECT p.Planogram_seq, p.Enterprise_id, p.Category_id, c.Category_dsc,
         p.Supermarketchain_id, ch.Supermarketchain, p.Retailer_id, r.Retailer_dsc,
         p.Formato, p.Up_date, p.Down_date, p.Status, p.Flow_direction, p.Notes,
         p.Loaded_userid, p.URL_picture
  FROM ${TABLE} p
  LEFT JOIN RETSC_OP_CATEGORIES c  ON c.Category_id          = p.Category_id
  LEFT JOIN RETSC_OP_SMKTCHAINS ch ON ch.Supermarketchain_id = p.Supermarketchain_id
  LEFT JOIN RETSC_OP_RETAILER   r  ON r.Retailer_id          = p.Retailer_id`;

const listChains = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT Supermarketchain_id, Supermarketchain, parentchain_id
    FROM RETSC_OP_SMKTCHAINS
    ORDER BY Supermarketchain`);
  return r.recordset;
};

const findChainById = async (chainId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, chainId)
    .query(`SELECT Supermarketchain_id, Supermarketchain FROM RETSC_OP_SMKTCHAINS WHERE Supermarketchain_id = @id`);
  return r.recordset[0] ?? null;
};

// Inserta el encabezado en estado BORRADOR (lo aprueba la pantalla de revisión, Fase 8).
const insertDraft = async ({
  enterpriseId, categoryId, supermarketchainId, retailerId, formato,
  upDate, downDate, flowDirection, notes, loadedUserId, urlPicture,
}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId',  sql.Int,           enterpriseId)
    .input('categoryId',    sql.Int,           categoryId)
    .input('chainId',       sql.Int,           supermarketchainId)
    .input('retailerId',    sql.Int,           retailerId)
    .input('formato',       sql.VarChar(50),   formato ?? null)
    .input('upDate',        sql.Date,          upDate)
    .input('downDate',      sql.Date,          downDate ?? null)
    .input('flow',          sql.VarChar(20),   flowDirection)
    .input('notes',         sql.NVarChar(255), notes ?? null)
    .input('userId',        sql.Int,           loadedUserId ?? null)
    .input('url',           sql.VarChar(255),  urlPicture)
    .query(`
      INSERT INTO ${TABLE}
        (Enterprise_id, Category_id, Supermarketchain_id, Formato, Retailer_id, Up_date, Down_date,
         Status, Notes, Loaded_userid, URL_picture, Flow_direction)
      OUTPUT INSERTED.Planogram_seq
      VALUES
        (@enterpriseId, @categoryId, @chainId, @formato, @retailerId, @upDate, @downDate,
         'BORRADOR', @notes, @userId, @url, @flow)
    `);
  return r.recordset[0].Planogram_seq;
};

// Siempre filtrado por empresa: un usuario solo ve los planogramas de la suya.
const findBySeq = async (seq, enterpriseId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('seq',          sql.Int, seq)
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`${SELECT_WITH_NAMES} WHERE p.Planogram_seq = @seq AND p.Enterprise_id = @enterpriseId`);
  return r.recordset[0] ?? null;
};

const listByEnterprise = async (enterpriseId, { status, categoryId, retailerId } = {}) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('enterpriseId', sql.Int,         enterpriseId)
    .input('status',       sql.VarChar(10), status ?? null)
    .input('categoryId',   sql.Int,         categoryId ?? null)
    .input('retailerId',   sql.Int,         retailerId ?? null)
    .query(`${SELECT_WITH_NAMES}
      WHERE p.Enterprise_id = @enterpriseId
        AND (@status     IS NULL OR p.Status      = @status)
        AND (@categoryId IS NULL OR p.Category_id = @categoryId)
        AND (@retailerId IS NULL OR p.Retailer_id = @retailerId)
      ORDER BY p.Planogram_seq DESC`);
  return r.recordset;
};

// Ciclo 5 · B4 (Fase 8.8) — Aprobación en UNA transacción (plan B4):
//   1) bloquea el encabezado y verifica que siga en BORRADOR (evita doble aprobación);
//   2) graba el detalle (RETSC_OP_PLANOGRAMDET, una fila por posición; borra antes cualquier
//      resto de un intento anterior de este mismo planograma);
//   3) cierra el planograma ACTIVO anterior del MISMO alcance: misma empresa + categoría y
//      misma tienda — o, si el nuevo es para toda la cadena (Retailer_id NULL), el anterior de
//      toda la cadena. Down_date = día anterior al Up_date del nuevo (nunca antes de su Up_date);
//   4) activa el nuevo.
// Si algo falla → ROLLBACK: no quedan filas a medias en el detalle (criterio B5).
const DET_CHUNK = 150;   // 9 parámetros por fila → 1350 por INSERT (SQL Server admite 2100)

const aprobarPlanograma = async ({ seq, enterpriseId, filas }) => {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const head = await new sql.Request(tx)
      .input('seq', sql.Int, seq)
      .input('enterpriseId', sql.Int, enterpriseId)
      .query(`
        SELECT Planogram_seq, Status, Up_date, Category_id, Retailer_id, Supermarketchain_id
        FROM ${TABLE} WITH (UPDLOCK, HOLDLOCK)
        WHERE Planogram_seq = @seq AND Enterprise_id = @enterpriseId`);
    const p = head.recordset[0];
    if (!p) throw Object.assign(new Error(`Planograma ${seq} no encontrado.`), { statusCode: 404, errorCode: 'ERR_NO_ENCONTRADO' });
    if (p.Status !== 'BORRADOR') throw Object.assign(new Error(`El planograma ${seq} ya no está en borrador (${p.Status}).`), { statusCode: 409, errorCode: 'ERR_NO_ES_BORRADOR' });

    await new sql.Request(tx).input('seq', sql.Int, seq).query('DELETE FROM RETSC_OP_PLANOGRAMDET WHERE Planogram_seq = @seq');
    for (let i = 0; i < filas.length; i += DET_CHUNK) {
      const chunk = filas.slice(i, i + DET_CHUNK);
      const req = new sql.Request(tx).input('seq', sql.Int, seq);
      const values = chunk.map((f, k) => {
        req.input(`u${k}`, sql.Int, f.Shelfunit_id)
          .input(`l${k}`, sql.Int, f.Shelflevel_id)
          .input(`c${k}`, sql.Int, f.Shelfcolumn_id)
          .input(`f${k}`, sql.Int, f.Facings)
          .input(`h${k}`, sql.Float, f.Height)
          .input(`w${k}`, sql.Float, f.Width)
          .input(`d${k}`, sql.Float, f.Depth)
          .input(`s${k}`, sql.Int, f.sku_id);
        return `(@seq, @u${k}, @l${k}, @c${k}, @f${k}, @h${k}, @w${k}, @d${k}, @s${k})`;
      });
      await req.query(`
        INSERT INTO RETSC_OP_PLANOGRAMDET
          (Planogram_seq, Shelfunit_id, Shelflevel_id, Shelfcolumn_id, Facings, Height, Width, Depth, sku_id)
        VALUES ${values.join(',\n')}`);
    }

    const cerrados = await new sql.Request(tx)
      .input('seq', sql.Int, seq)
      .input('enterpriseId', sql.Int, enterpriseId)
      .input('categoryId', sql.Int, p.Category_id)
      .input('retailerId', sql.Int, p.Retailer_id)
      .input('chainId', sql.Int, p.Supermarketchain_id)
      .input('upDate', sql.Date, p.Up_date)
      .query(`
        UPDATE ${TABLE}
        SET Status = 'INACTIVO',
            Down_date = CASE
              WHEN @upDate IS NULL THEN CAST(SYSUTCDATETIME() AS date)
              WHEN Up_date IS NOT NULL AND Up_date > DATEADD(DAY, -1, @upDate) THEN Up_date
              ELSE DATEADD(DAY, -1, @upDate) END
        OUTPUT INSERTED.Planogram_seq, INSERTED.Down_date
        WHERE Enterprise_id = @enterpriseId AND Category_id = @categoryId AND Status = 'ACTIVO'
          AND Planogram_seq <> @seq
          AND ( (@retailerId IS NOT NULL AND Retailer_id = @retailerId)
             OR (@retailerId IS NULL AND Retailer_id IS NULL AND Supermarketchain_id = @chainId) )`);

    await new sql.Request(tx).input('seq', sql.Int, seq)
      .query(`UPDATE ${TABLE} SET Status = 'ACTIVO' WHERE Planogram_seq = @seq`);
    await tx.commit();
    return { filas: filas.length, inactivados: cerrados.recordset.map((r) => ({ Planogram_seq: r.Planogram_seq, Down_date: r.Down_date })) };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
};

// Herramienta de reporte (scripts/): sin filtro de empresa.
const findBySeqs = async (seqs) => {
  const ids = [...new Set((seqs ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const pool = await getPool();
  const req = pool.request();
  ids.forEach((id, k) => req.input(`s${k}`, sql.Int, id));
  const r = await req.query(`${SELECT_WITH_NAMES} WHERE p.Planogram_seq IN (${ids.map((_, k) => `@s${k}`).join(', ')}) ORDER BY p.Planogram_seq`);
  return r.recordset;
};

// Detalle grabado de un planograma aprobado (para el reporte y la consulta).
const listDetail = async (seq) => {
  const pool = await getPool();
  const r = await pool.request().input('seq', sql.Int, seq).query(`
    SELECT d.Product_seq, d.Shelfunit_id, d.Shelflevel_id, d.Shelfcolumn_id, d.Facings, d.Height, d.Width, d.Depth, d.sku_id, s.EAN, s.Product_dsc
    FROM RETSC_OP_PLANOGRAMDET d LEFT JOIN RETSC_OP_SKUS s ON s.SKU_ID = d.sku_id
    WHERE d.Planogram_seq = @seq
    ORDER BY d.Shelfunit_id, d.Shelflevel_id, d.Shelfcolumn_id`);
  return r.recordset;
};

module.exports = { listChains, findChainById, insertDraft, findBySeq, listByEnterprise, aprobarPlanograma, findBySeqs, listDetail };
