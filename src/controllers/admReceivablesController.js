/**
 * admReceivablesController.js — Capa HTTP de cuentas por cobrar (/api/adm/aging y /api/adm/receivables).
 *
 * Para qué sirve: toma los filtros de la petición, llama al servicio y arma la respuesta:
 *   JSON { success, ... } o, para ?export=csv, el archivo CSV para descargar.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 */

const service = require('../services/admReceivablesService');
// Mismo util de CSV que el dashboard: escribe BOM, cabeceras, Content-Type y Content-Disposition.
const { sendCsv } = require('../utils/csvExport');

// Etiqueta con la que este controlador registra sus errores 500.
const TAG = '[adm/receivables]';

// Convierte un error del servicio en respuesta HTTP. Mismo patrón que admContractController:
// el 500 se registra en consola; el resto son errores esperados con su statusCode.
// Los errores 500 responden un mensaje fijo y se registran sin datos sensibles (ver abajo).
function handleError(res, err) {
  const status = err?.statusCode || 500;

  // Errores del servidor (500 o más): NUNCA se devuelve err.message ni err.payload al navegador,
  // porque un error del driver SQL trae nombres de servidor, usuario, tablas y columnas.
  if (status >= 500) {
    // ¿Es un error de SQL? Los de mssql traen `number` (código de SQL Server) u `originalError`.
    const isSqlError = err?.number != null || err?.originalError != null;
    // Se registra un objeto SEGURO: nada del objeto err completo, ni su stack, ni req.body.
    const logEntry = { tag: TAG, name: err?.name ?? null, code: err?.code ?? err?.number ?? null };
    // El mensaje solo se registra si NO es de SQL (por ejemplo un TypeError de programación),
    // porque el texto de un error SQL puede traer datos de conexión.
    if (!isSqlError) logEntry.message = err?.message ?? String(err);
    console.error(logEntry);
    return res.status(status).json({ success: false, message: 'Error interno del servidor' });
  }

  // Errores esperados (400-499): igual que antes. err.payload trae datos extra, por ejemplo
  // { field } para marcar el campo en pantalla.
  return res.status(status).json({ success: false, message: err.message, ...(err.payload ?? {}) });
}

// GET /api/adm/aging — antigüedad de saldos. Solo DTC. Con ?export=csv descarga un CSV.
const getAging = async (req, res) => {
  try {
    const result = await service.getAging(req.query);
    if (result.format === 'csv') {
      // sendCsv arma el archivo con el formato acordado (";", coma decimal, BOM) y lo manda
      // como descarga (Content-Disposition: attachment) con el nombre que da el servicio.
      return await sendCsv(res, { filename: result.filename, columns: result.columns, rows: result.rows });
    }
    return res.json({ success: true, aging: result.aging });
  } catch (err) { return handleError(res, err); }
};

// GET /api/adm/receivables — facturas con saldo para la pantalla de cuentas por cobrar. Solo DTC.
const listReceivables = async (req, res) => {
  try {
    const receivables = await service.listReceivables(req.query);
    return res.json({ success: true, receivables });
  } catch (err) { return handleError(res, err); }
};

module.exports = { getAging, listReceivables };
