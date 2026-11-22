/**
 * admValidation.js — Errores y validadores del módulo administrativo (/api/adm).
 *
 * Para qué sirve: centraliza las validaciones de entrada (texto, montos, fechas, listas
 *   de valores) y el formato de error que pide la especificación: HTTP 422 con el campo
 *   y el motivo en español, listos para mostrarse tal cual en la pantalla.
 * Dependencias externas pendientes: ninguna.
 * TODO conocidos:
 *   // TODO: si más módulos necesitan estos validadores, moverlos a un util compartido.
 *
 * NOTA: el resto del backend usa 400 para validación. /api/adm usa 422 porque así lo
 *   exige la especificación del módulo y es un router independiente.
 */

// Crea un Error con statusCode (y payload opcional) para que handleError lo convierta
// en respuesta HTTP. Mismo patrón que svcError de userService/roleService, que no se exporta.
function svcError(msg, statusCode, payload) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  if (payload !== undefined) err.payload = payload;
  return err;
}

// Error de validación: 422 + { field } para que la pantalla marque el campo correcto.
function fieldError(field, message) {
  return svcError(message, 422, { field });
}

// Texto obligatorio: sin espacios sobrantes, no vacío y con un largo máximo.
function requiredString(value, field, label, max) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw fieldError(field, `${label} es obligatorio.`);
  if (v.length > max) throw fieldError(field, `${label} no puede superar ${max} caracteres.`);
  return v;
}

// Texto opcional: vacío o ausente se guarda como NULL.
function optionalString(value, field, label, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw fieldError(field, `${label} debe ser texto.`);
  const v = value.trim();
  if (v.length > max) throw fieldError(field, `${label} no puede superar ${max} caracteres.`);
  return v === '' ? null : v;
}

// Valor que debe estar en una lista. Se normaliza a MAYÚSCULAS porque los estados
// de la base van en mayúsculas.
function oneOf(value, field, label, allowed) {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!allowed.includes(v)) {
    throw fieldError(field, `${label} debe ser uno de: ${allowed.join(', ')}.`);
  }
  return v;
}

// Monto >= 0 con máximo 2 decimales (la base usa decimal(18,2)). Acepta número o texto numérico.
function money(value, field, label) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw fieldError(field, `${label} debe ser un número mayor o igual a 0.`);
  }
  // toFixed(2) redondea a 2 decimales; si cambia el valor, el usuario mandó más de 2 decimales.
  if (Number(n.toFixed(2)) !== n) throw fieldError(field, `${label} admite como máximo 2 decimales.`);
  if (n >= 1e15) throw fieldError(field, `${label} es demasiado grande.`);
  return n;
}

// Entero dentro de un rango (incluye los extremos).
function intInRange(value, field, label, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw fieldError(field, `${label} debe ser un número entero entre ${min} y ${max}.`);
  }
  return n;
}

// Entero positivo obligatorio (para ids).
function positiveInt(value, field, label) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n <= 0) throw fieldError(field, `${label} no es válido.`);
  return n;
}

// Entero positivo opcional: devuelve null si no viene (por ejemplo ?enterpriseId= ausente).
function optionalPositiveInt(value, field, label) {
  if (value === undefined || value === null || value === '') return null;
  return positiveInt(value, field, label);
}

// Fecha sin hora en formato AAAA-MM-DD. Se valida que sea un día real (no 2026-02-31).
// Se devuelve como texto: la base la convierte con CAST(... AS date), así no hay
// corrimientos por zona horaria.
function dateOnly(value, field, label, { required }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fieldError(field, `${label} es obligatoria.`);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw fieldError(field, `${label} debe tener el formato AAAA-MM-DD.`);
  }
  const d = new Date(`${value}T00:00:00Z`);
  // Si la fecha no existe (31 de febrero), JavaScript la "corrige" y deja de coincidir.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw fieldError(field, `${label} no es una fecha válida.`);
  }
  return value;
}

// Booleano obligatorio. Acepta true/false y 1/0 (el resto del sistema normaliza BIT a 1/0).
function requiredBool(value, field, label) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  throw fieldError(field, `${label} es obligatorio (true o false).`);
}

module.exports = {
  svcError, fieldError, requiredString, optionalString, oneOf, money,
  intInRange, positiveInt, optionalPositiveInt, dateOnly, requiredBool,
};
