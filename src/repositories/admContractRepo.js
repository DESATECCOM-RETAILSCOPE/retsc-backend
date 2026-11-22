/**
 * admContractRepo.js — Acceso a RETSC_ADM_CONTRACT (contratos por empresa).
 *
 * Para qué sirve: leer contratos y crearlos o editarlos. Cada escritura corre en una
 *   transacción que incluye la fila de bitácora (regla de la especificación).
 * Dependencias externas pendientes: ninguna. (Tablas e índices ya verificados en QA.)
 * TODO conocidos:
 *   // TODO: GET /api/adm/audit (consulta de bitácora) llega en un paso posterior.
 *
 * NOTA: las fechas (Start_date, End_date) se reciben como texto AAAA-MM-DD y se
 *   convierten en SQL con CAST(... AS date). Así no dependen de la zona horaria del
 *   servidor Node. Created_at / Updated_at se guardan en UTC con SYSUTCDATETIME().
 */

const { getPool, sql } = require('../config/db');
const auditRepo = require('./admAuditRepo');

const TABLE = 'RETSC_ADM_CONTRACT';

// Columnas que se pueden editar con PUT y cómo se envían a SQL. Es una lista cerrada
// a propósito: los nombres de columna salen de aquí y NUNCA del texto del usuario,
// lo que evita inyección SQL en el SET dinámico.
//   type: tipo de la librería mssql; cast: expresión SQL cuando hay que convertir.
const UPDATABLE = {
  Plan_code:         { type: sql.VarChar(30) },
  Status:            { type: sql.VarChar(15) },
  Start_date:        { type: sql.VarChar(10), cast: 'CAST(@p_Start_date AS date)' },
  End_date:          { type: sql.VarChar(10), cast: 'CAST(@p_End_date AS date)' },
  Billing_frequency: { type: sql.VarChar(12) },
  Amount_per_period: { type: sql.Decimal(18, 2) },
  Currency:          { type: sql.Char(3) },
  Payment_method:    { type: sql.VarChar(15) },
  Credit_days:       { type: sql.Int },
  Requires_po:       { type: sql.Bit },
  Issuer_name:       { type: sql.NVarChar(150) },
};

// Contrato ACTIVO de la empresa (como máximo uno, lo garantiza un índice único filtrado).
const findActiveByEnterprise = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE Enterprise_id = @enterpriseId AND Status = 'ACTIVO'`);
  return r.recordset[0] ?? null;
};

// Todos los contratos de la empresa (la consola de DTC edita también borradores y finalizados).
const listByEnterprise = async (enterpriseId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('enterpriseId', sql.Int, enterpriseId)
    .query(`SELECT * FROM ${TABLE} WHERE Enterprise_id = @enterpriseId ORDER BY Contract_id DESC`);
  return r.recordset;
};

// Un contrato por su id, o null si no existe.
const findById = async (contractId) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('contractId', sql.Int, contractId)
    .query(`SELECT * FROM ${TABLE} WHERE Contract_id = @contractId`);
  return r.recordset[0] ?? null;
};

// Crea un contrato y su fila de bitácora (CREATE) en una sola transacción.
// Si el INSERT falla (por ejemplo, ya hay un contrato ACTIVO), se hace rollback y el
// error sube al servicio, que lo traduce a un 422.
const createWithAudit = async (rec, { userId, ipAddress }) => {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const r = await transaction
      .request()
      .input('enterpriseId', sql.Int, rec.enterpriseId)
      .input('planCode', sql.VarChar(30), rec.planCode)
      .input('status', sql.VarChar(15), rec.status)
      .input('startDate', sql.VarChar(10), rec.startDate)
      .input('endDate', sql.VarChar(10), rec.endDate)
      .input('billingFrequency', sql.VarChar(12), rec.billingFrequency)
      .input('amountPerPeriod', sql.Decimal(18, 2), rec.amountPerPeriod)
      .input('currency', sql.Char(3), rec.currency)
      .input('paymentMethod', sql.VarChar(15), rec.paymentMethod)
      .input('creditDays', sql.Int, rec.creditDays)
      .input('requiresPo', sql.Bit, rec.requiresPo)
      .input('issuerName', sql.NVarChar(150), rec.issuerName)
      .input('userId', sql.Int, userId)
      .query(`
        INSERT INTO ${TABLE}
          (Enterprise_id, Plan_code, Status, Start_date, End_date, Billing_frequency,
           Amount_per_period, Currency, Payment_method, Credit_days, Requires_po,
           Issuer_name, Created_at, Created_userid)
        OUTPUT INSERTED.*
        VALUES
          (@enterpriseId, @planCode, @status, CAST(@startDate AS date), CAST(@endDate AS date),
           @billingFrequency, @amountPerPeriod, @currency, @paymentMethod, @creditDays,
           @requiresPo, @issuerName, CAST(SYSUTCDATETIME() AS datetime2(0)), @userId)
      `);
    const row = r.recordset[0];

    await auditRepo.insertInTransaction(transaction, {
      entityType: 'CONTRACT',
      entityId: row.Contract_id,
      action: 'CREATE',
      newValue: row,
      userId,
      ipAddress,
    });

    await transaction.commit();
    return row;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

// Edita solo las columnas indicadas en `changes` (claves = nombres de columna) y deja la
// bitácora con el valor anterior y el nuevo de ESAS columnas. Todo en una transacción.
// Devuelve la fila actualizada.
const updateWithAudit = async (contractId, changes, { userId, ipAddress }) => {
  const columns = Object.keys(changes);
  // Defensa: solo columnas de la lista cerrada. Una clave desconocida es un error del código.
  for (const col of columns) {
    if (!UPDATABLE[col]) throw new Error(`Columna no editable: ${col}`);
  }

  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    // Lee la fila actual BLOQUEÁNDOLA (UPDLOCK) para que nadie la cambie entre esta
    // lectura y el UPDATE. De aquí salen los "valores anteriores" de la bitácora.
    const cur = await transaction
      .request()
      .input('contractId', sql.Int, contractId)
      .query(`SELECT * FROM ${TABLE} WITH (UPDLOCK, ROWLOCK) WHERE Contract_id = @contractId`);
    const oldRow = cur.recordset[0];
    if (!oldRow) {
      const notFound = new Error('Contrato no encontrado.');
      notFound.statusCode = 404;
      throw notFound;
    }

    // Arma "Columna = @p_Columna" (o con CAST para fechas) usando solo la lista cerrada.
    const req = transaction.request().input('contractId', sql.Int, contractId).input('userId', sql.Int, userId);
    const setParts = columns.map((col) => {
      const def = UPDATABLE[col];
      req.input(`p_${col}`, def.type, changes[col]);
      return `${col} = ${def.cast ?? `@p_${col}`}`;
    });
    // Siempre se registra quién y cuándo editó.
    setParts.push('Updated_at = CAST(SYSUTCDATETIME() AS datetime2(0))', 'Updated_userid = @userId');

    const upd = await req.query(`
      UPDATE ${TABLE}
      SET ${setParts.join(', ')}
      OUTPUT INSERTED.*
      WHERE Contract_id = @contractId
    `);
    const newRow = upd.recordset[0];

    // Bitácora: solo las columnas que cambiaron, antes y después.
    const pick = (row) => Object.fromEntries(columns.map((c) => [c, row[c]]));
    // Si cambió el estado, se registra como STATUS_CHANGE; si no, como UPDATE.
    const statusChanged = columns.includes('Status') && oldRow.Status !== newRow.Status;
    await auditRepo.insertInTransaction(transaction, {
      entityType: 'CONTRACT',
      entityId: contractId,
      action: statusChanged ? 'STATUS_CHANGE' : 'UPDATE',
      oldValue: pick(oldRow),
      newValue: pick(newRow),
      userId,
      ipAddress,
    });

    await transaction.commit();
    return newRow;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

module.exports = {
  findActiveByEnterprise,
  listByEnterprise,
  findById,
  createWithAudit,
  updateWithAudit,
};
