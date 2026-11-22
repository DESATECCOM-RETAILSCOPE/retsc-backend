/**
 * admReceivablesRepo.js — Lecturas de cuentas por cobrar: antigüedad de saldos y facturas con saldo.
 *
 * Para qué sirve: alimenta la pantalla "Cuentas por cobrar" de la consola DTC.
 *   - listAging       : RETSC_ADM_V_AGING (una fila por empresa y moneda) + nombre de la empresa.
 *   - listReceivables : RETSC_ADM_V_INVOICE_BALANCE (solo facturas con saldo) + nombre de la empresa
 *                       + la ÚLTIMA nota de cobro de cada factura + banderas calculadas en SQL.
 * Dependencias externas pendientes: ninguna. (Vistas y tablas ya verificadas en QA.)
 * TODO conocidos:
 *   // TODO: paginación de listReceivables cuando el volumen lo pida.
 *
 * NOTA: solo lectura. Este archivo no escribe, así que no abre transacciones ni audita.
 * NOTA: de RETSC_OP_ENTERPRISE solo se lee Enterprise_dsc (el nombre). Nada de datos fiscales.
 * NOTA: las consultas se arman en funciones puras (build*Query) que devuelven el texto SQL y
 *   los parámetros. Así las pruebas pueden revisar el SQL sin conectarse a la base.
 */

const { getPool, sql } = require('../config/db');
const { TODAY_CR_SQL } = require('./admInvoiceRepo');

const AGING_VIEW = 'RETSC_ADM_V_AGING';
const BALANCE_VIEW = 'RETSC_ADM_V_INVOICE_BALANCE';
const NOTE_TABLE = 'RETSC_ADM_COLLECTION_NOTE';
const ENTERPRISE_TABLE = 'RETSC_OP_ENTERPRISE';

// Días hacia adelante que cuentan como "vence pronto" (spec, sección 8: próximos 7 días).
const DUE_SOON_DAYS = 7;

// Ejecuta una consulta armada por un build*Query: registra cada parámetro con su tipo.
async function run({ text, params }) {
  const pool = await getPool();
  const req = pool.request();
  for (const p of params) req.input(p.name, p.type, p.value);
  const r = await req.query(text);
  return r.recordset;
}

// Arma la consulta de antigüedad de saldos. Filtros opcionales: enterpriseId y currency.
const buildAgingQuery = ({ enterpriseId = null, currency = null } = {}) => {
  const params = [];
  const where = [];
  if (enterpriseId != null) {
    params.push({ name: 'enterpriseId', type: sql.Int, value: enterpriseId });
    where.push('a.Enterprise_id = @enterpriseId');
  }
  if (currency) {
    params.push({ name: 'currency', type: sql.Char(3), value: currency });
    where.push('a.Currency = @currency');
  }
  // NOTA: "orden por empresa" se interpreta como orden por NOMBRE de la empresa (lo que ve la
  //   pantalla); Enterprise_id desempata empresas con el mismo nombre o sin nombre.
  const text = `
    SELECT a.Enterprise_id, e.Enterprise_dsc, a.Currency,
           a.Vigente, a.Vencido_1_30, a.Vencido_31_60, a.Vencido_61_90, a.Vencido_mas_90,
           a.Saldo_total, a.Facturas_con_saldo
    FROM ${AGING_VIEW} a
    LEFT JOIN ${ENTERPRISE_TABLE} e ON e.Enterprise_id = a.Enterprise_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.Enterprise_dsc ASC, a.Enterprise_id ASC, a.Currency ASC
  `;
  return { text, params };
};

// Arma la consulta de facturas con saldo. Filtros opcionales: enterpriseId, currency y
// filter = 'overdue' | 'dueSoon' | 'followUp'.
//   Due_soon      = vence entre hoy y hoy + 7 días (ambos incluidos), en hora de Costa Rica.
//   Follow_up_due = la última nota pide volver a contactar hoy o antes.
//   Overdue       = Days_overdue > 0 (la vista ya lo calcula en hora de Costa Rica).
// La consulta interna calcula las banderas y la externa filtra y ordena por ellas, para no
// repetir las expresiones en el WHERE.
const buildReceivablesQuery = ({ enterpriseId = null, currency = null, filter = null } = {}) => {
  const params = [{ name: 'dueSoonDays', type: sql.Int, value: DUE_SOON_DAYS }];
  const inner = ['b.Balance > 0'];
  if (enterpriseId != null) {
    params.push({ name: 'enterpriseId', type: sql.Int, value: enterpriseId });
    inner.push('b.Enterprise_id = @enterpriseId');
  }
  if (currency) {
    params.push({ name: 'currency', type: sql.Char(3), value: currency });
    inner.push('b.Currency = @currency');
  }

  // Filtro de la pantalla sobre las banderas ya calculadas. Lista cerrada: el texto SQL sale
  // de aquí y nunca del usuario.
  const OUTER_FILTERS = {
    overdue: 'x.Overdue = 1',
    dueSoon: 'x.Due_soon = 1',
    followUp: 'x.Follow_up_due = 1',
  };
  const outer = filter ? OUTER_FILTERS[filter] : null;

  const text = `
    DECLARE @hoy date = ${TODAY_CR_SQL};
    SELECT * FROM (
      SELECT b.Invoice_id, b.Enterprise_id, e.Enterprise_dsc, b.Contract_id, b.Invoice_number,
             b.Due_date, b.Currency, b.Total_amount, b.Balance, b.Payment_status,
             b.Days_overdue, b.Aging_bucket,
             n.Next_contact_date, n.Note AS Last_note,
             CASE WHEN b.Days_overdue > 0 THEN 1 ELSE 0 END AS Overdue,
             CASE WHEN b.Due_date >= @hoy AND b.Due_date <= DATEADD(DAY, @dueSoonDays, @hoy)
                  THEN 1 ELSE 0 END AS Due_soon,
             CASE WHEN n.Next_contact_date IS NOT NULL AND n.Next_contact_date <= @hoy
                  THEN 1 ELSE 0 END AS Follow_up_due
      FROM ${BALANCE_VIEW} b
      LEFT JOIN ${ENTERPRISE_TABLE} e ON e.Enterprise_id = b.Enterprise_id
      -- Última nota de cada factura (la de Note_id más alto). OUTER APPLY deja la factura
      -- aunque no tenga ninguna nota (en ese caso Next_contact_date y Last_note son NULL).
      OUTER APPLY (
        SELECT TOP 1 cn.Note, cn.Next_contact_date
        FROM ${NOTE_TABLE} cn
        WHERE cn.Invoice_id = b.Invoice_id
        ORDER BY cn.Note_id DESC
      ) n
      WHERE ${inner.join(' AND ')}
    ) x
    ${outer ? `WHERE ${outer}` : ''}
    ORDER BY x.Follow_up_due DESC, x.Due_date ASC, x.Invoice_id ASC
  `;
  return { text, params };
};

// Antigüedad de saldos (una fila por empresa y moneda).
const listAging = async (filters) => run(buildAgingQuery(filters));

// Facturas con saldo para la pantalla de cuentas por cobrar.
const listReceivables = async (filters) => run(buildReceivablesQuery(filters));

module.exports = { DUE_SOON_DAYS, buildAgingQuery, buildReceivablesQuery, listAging, listReceivables };
