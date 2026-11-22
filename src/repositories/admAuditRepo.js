/**
 * admAuditRepo.js — Escritura en la bitácora RETSC_ADM_AUDIT_LOG.
 *
 * Para qué sirve: cada escritura del módulo administrativo debe dejar una fila en la
 *   bitácora, DENTRO de la misma transacción que el cambio. Si el cambio falla, la fila
 *   de bitácora se deshace con él; si la bitácora falla, el cambio también se deshace.
 * Dependencias externas pendientes: ninguna. (La tabla ya existe en QA y el usuario del
 *   backend solo tiene SELECT e INSERT sobre ella; UPDATE y DELETE están denegados.)
 * TODO conocidos:
 *   // TODO: agregar la consulta de bitácora (GET /api/adm/audit) en el paso de pruebas
 *   //       de seguridad; por ahora este repo solo inserta.
 *
 * NOTA: la bitácora es de solo inserción. Este archivo NO debe tener UPDATE ni DELETE.
 */

const { sql } = require('../config/db');

// Inserta una fila de bitácora usando la transacción que recibe (no abre una propia).
//   transaction: transacción abierta por el repositorio que hace el cambio
//   entityType : CONTRACT | PO | INVOICE | PAYMENT | DOCUMENT | BILLING_PROFILE
//   action     : CREATE | UPDATE | STATUS_CHANGE | VOID | DOWNLOAD
//   oldValue / newValue: objetos con los campos antes y después (se guardan como JSON)
const insertInTransaction = async (
  transaction,
  { entityType, entityId, action, oldValue = null, newValue = null, userId, ipAddress = null },
) => {
  await transaction
    .request()
    .input('entityType', sql.VarChar(30), entityType)
    .input('entityId', sql.Int, entityId)
    .input('action', sql.VarChar(30), action)
    .input('oldValue', sql.NVarChar(sql.MAX), oldValue == null ? null : JSON.stringify(oldValue))
    .input('newValue', sql.NVarChar(sql.MAX), newValue == null ? null : JSON.stringify(newValue))
    .input('userId', sql.Int, userId)
    // La columna es varchar(45): se corta por si llega una IP más larga (IPv6 con prefijo).
    .input('ipAddress', sql.VarChar(45), ipAddress ? String(ipAddress).slice(0, 45) : null)
    .query(`
      INSERT INTO RETSC_ADM_AUDIT_LOG
        (Entity_type, Entity_id, Action, Old_value, New_value, User_id, Created_at, Ip_address)
      VALUES
        (@entityType, @entityId, @action, @oldValue, @newValue, @userId,
         CAST(SYSUTCDATETIME() AS datetime2(0)), @ipAddress)
    `);
};

module.exports = { insertInTransaction };
