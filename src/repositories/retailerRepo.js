// Repositorio de solo-lectura para resolver el canal (OMT/DTT/CONVENIENCE) de un PDV.
//
// TEMPORAL / SIN CONFIRMAR — la guía "Fotos de Visita" v1.9 (sección 2.2, 3.2) da por hecho
// que RETSC_OP_RETAILER ya existe con una columna Canal, y que el canal de una visita/foto
// siempre se resuelve por Retailer_id → RETSC_OP_RETAILER.Canal (nunca se pregunta ni se
// duplica). Pero CLAUDE.md de este mismo repo (sección "Menú por rol", auditoría 2026-07-25)
// dice lo contrario: "no hay tabla de retailers — RETSC_EX_SHELFPHOTO.Retailer_id es solo
// una columna suelta sin catálogo detrás" — y pide explícitamente no inventar ese catálogo
// sin que el equipo lo pida.
//
// No se puede verificar el esquema real desde este entorno (sin acceso a la BD). Este
// repositorio asume que la tabla SÍ existe (tal como dice la guía) pero degrada de forma
// segura si no: cualquier error de "Invalid object name" (o similar) se atrapa y se
// devuelve null, en vez de tumbar el flujo entero de apertura/registro de visita por una
// tabla de catálogo que hoy no es indispensable para abrir/cerrar una visita ni para
// guardar una foto.
//
// TODO: confirmar con María/equipo si RETSC_OP_RETAILER existe de verdad en la BD real
// (posible que el CLAUDE.md haya quedado desactualizado) y, si no, decidir si se crea
// — no se crea en la migración 008 a propósito, ver su header.

const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_RETAILER';

// Catálogo completo de PDVs para el mapa de selección del mobile (Paso 0, previo a abrir
// visita). Sin scoping por enterprise — RETSC_OP_RETAILER no tiene columna enterprise_id,
// es catálogo global de tiendas, igual que RETSC_OP_CATEGORIES.
const list = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT Retailer_id, Retailer_dsc, Supermarketchain_id, Formato, latitud, longitud,
           Ejecutivo_asignado, Zona, Prioridad, Canal, pais_dsc
    FROM ${TABLE}
    ORDER BY Retailer_dsc
  `);
  return r.recordset;
};

// Devuelve el canal (OMT | DTT | CONVENIENCE) de un retailer, o null si la tabla no existe
// todavía, si el retailer no tiene canal asignado, o si el retailer no existe.
const resolveCanalByRetailer = async (retailerId) => {
  if (retailerId == null) return null;

  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Int, retailerId)
      .query(`SELECT Canal FROM ${TABLE} WHERE Retailer_id = @id`);
    return r.recordset[0]?.Canal ?? null;
  } catch (err) {
    console.warn(`[retailerRepo] no se pudo resolver canal para Retailer_id=${retailerId} — ${err.message}`);
    return null;
  }
};

module.exports = { list, resolveCanalByRetailer };
