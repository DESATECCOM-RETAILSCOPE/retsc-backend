/**
 * admSqlErrors.js — Reconoce errores de SQL Server para traducirlos a mensajes claros.
 *
 * Para qué sirve: la base es la autoridad de las reglas (índices únicos, CHECK, llaves
 *   foráneas). Cuando una de ellas rechaza una escritura, el servicio usa estas funciones
 *   para convertir el error técnico en un 422 en español.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos: ninguno.
 */

// Número de error de SQL Server. La librería mssql lo expone en err.number, y a veces
// dentro de originalError, según la versión.
function getSqlErrorNumber(err) {
  return err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number ?? null;
}

// ¿Violó un índice único? 2601 = índice único, 2627 = restricción UNIQUE.
// Si se indica indexName, además verifica que el mensaje mencione ese índice
// (el mensaje de SQL Server incluye el nombre del índice).
function isUniqueViolation(err, indexName) {
  const n = getSqlErrorNumber(err);
  if (n !== 2601 && n !== 2627) return false;
  return indexName ? String(err.message || '').includes(indexName) : true;
}

// ¿Violó una llave foránea? 547 también se usa para CHECK, por eso se mira el texto.
function isForeignKeyViolation(err) {
  return getSqlErrorNumber(err) === 547 && /FOREIGN KEY/i.test(String(err.message || ''));
}

module.exports = { getSqlErrorNumber, isUniqueViolation, isForeignKeyViolation };
