/**
 * admAuditQueryRepo.js — Consulta de la bitácora RETSC_ADM_AUDIT_LOG (solo lectura).
 *
 * Para qué sirve: alimenta la pantalla "Bitácora" de la consola DTC con filtros por entidad,
 *   acción, usuario y fechas, paginada hacia atrás por Audit_id.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 *
 * NOTA: es un archivo aparte de admAuditRepo.js a propósito: aquel solo INSERTA dentro de
 *   transacciones de escritura; este solo LEE. Ninguno de los dos hace UPDATE ni DELETE.
 * NOTA: de RETSC_OP_USERS se seleccionan SOLO User_id (para el JOIN) y User_name. Nunca el
 *   hash de contraseña, el correo, la cédula ni otra columna. La consulta se arma en una
 *   función pura (buildListQuery) para que las pruebas lo comprueben sin base.
 * NOTA: Created_at se guarda en UTC. Los filtros from/to llegan como días de Costa Rica
 *   (UTC-6): el día D en Costa Rica va de D 06:00 UTC a D+1 06:00 UTC (sin incluir).
 */

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_ADM_AUDIT_LOG';
const USERS_TABLE = 'RETSC_OP_USERS';

// Arma la consulta. Todos los filtros son opcionales salvo limit (lo fija el servicio).
//   entityType, entityId, action, userId : igualdad exacta
//   from, to : 'AAAA-MM-DD' en hora de Costa Rica, ambos extremos incluidos
//   beforeId : solo filas con Audit_id menor (para pedir la página siguiente)
const buildListQuery = ({ entityType, entityId, action, userId, from, to, beforeId, limit }) => {
  const params = [{ name: 'limit', type: sql.Int, value: limit }];
  const where = [];

  if (entityType) {
    params.push({ name: 'entityType', type: sql.VarChar(30), value: entityType });
    where.push('a.Entity_type = @entityType');
  }
  if (entityId != null) {
    params.push({ name: 'entityId', type: sql.Int, value: entityId });
    where.push('a.Entity_id = @entityId');
  }
  if (action) {
    params.push({ name: 'action', type: sql.VarChar(30), value: action });
    where.push('a.Action = @action');
  }
  if (userId != null) {
    params.push({ name: 'userId', type: sql.Int, value: userId });
    where.push('a.User_id = @userId');
  }
  if (from) {
    // Inicio del día "from" en Costa Rica = 06:00 UTC de ese día.
    params.push({ name: 'from', type: sql.VarChar(10), value: from });
    where.push('a.Created_at >= DATEADD(HOUR, 6, CAST(@from AS datetime2(0)))');
  }
  if (to) {
    // Fin del día "to" en Costa Rica = 06:00 UTC del día siguiente (sin incluir).
    params.push({ name: 'to', type: sql.VarChar(10), value: to });
    where.push('a.Created_at < DATEADD(HOUR, 6, DATEADD(DAY, 1, CAST(@to AS datetime2(0))))');
  }
  if (beforeId != null) {
    params.push({ name: 'beforeId', type: sql.BigInt, value: beforeId });
    where.push('a.Audit_id < @beforeId');
  }

  const text = `
    SELECT TOP (@limit)
           a.Audit_id, a.Entity_type, a.Entity_id, a.Action, a.Old_value, a.New_value,
           a.User_id, u.User_name, a.Created_at, a.Ip_address
    FROM ${TABLE} a
    LEFT JOIN ${USERS_TABLE} u ON u.User_id = a.User_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.Audit_id DESC
  `;
  return { text, params };
};

// Ejecuta la consulta de bitácora y devuelve las filas.
const list = async (filters) => {
  const { text, params } = buildListQuery(filters);
  const pool = await getPool();
  const req = pool.request();
  for (const p of params) req.input(p.name, p.type, p.value);
  const r = await req.query(text);
  return r.recordset;
};

module.exports = { buildListQuery, list };
