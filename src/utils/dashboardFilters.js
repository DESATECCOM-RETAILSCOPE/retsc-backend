// Filtros comunes del Dashboard web histórico (Parte B, Nuevo Ciclo 1).
//
// Cada endpoint del dashboard llama a resolveFilters(req, pantalla) y recibe los
// filtros ya validados. Concentra en un solo lugar dos reglas que no se negocian:
//
//   1. La empresa sale del token. Solo un usuario ADMIN_DTC puede pedir otra empresa
//      (el selector de empresa del mockup existe solo para DTC). Si un cliente pide
//      una empresa distinta de la suya, se responde 403: mismo patrón que
//      shelfPhotoController.listUnidentified.
//   2. Cada pantalla acepta solo sus filtros (según el mockup):
//        resumen, cumplimiento → empresa, category, chain, format, desde, hasta
//        catalogo              → empresa, category
//        modelo                → category (global por categoría, solo DTC)
//
// Fechas: el mockup arranca en "Últimos 90 días". Si no llegan desde/hasta, se usa
// hasta = hoy y desde = hoy - 89 días (90 días contando ambos extremos). Los queries
// deben filtrar con  Visit_start >= @desde AND Visit_start < @hastaExclusive  para no
// perder las visitas del último día después de las 00:00 (con BETWEEN se pierden).

const { ROLES, normalizeRole } = require('../config/roles');

const DEFAULT_DAYS = 90;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const SCREEN_FILTERS = Object.freeze({
  resumen:      { empresa: true,  category: true, chain: true,  format: true,  fechas: true  },
  cumplimiento: { empresa: true,  category: true, chain: true,  format: true,  fechas: true  },
  catalogo:     { empresa: true,  category: true, chain: false, format: false, fechas: false },
  modelo:       { empresa: false, category: true, chain: false, format: false, fechas: false },
});

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isAdminDtc(user) {
  return normalizeRole(user?.roleName) === ROLES.ADMIN_DTC;
}

// Entero positivo opcional. Vacío o ausente → null. Inválido → 400.
function parsePositiveInt(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0) {
    throw httpError(400, `El filtro "${name}" debe ser un número entero positivo.`);
  }
  return Number(s);
}

function parseIsoDate(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const s = String(value).trim();
  const d = new Date(`${s}T00:00:00.000Z`);
  if (!ISO_DATE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw httpError(400, `El filtro "${name}" debe ser una fecha válida con formato AAAA-MM-DD.`);
  }
  return s;
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIso(now) {
  return (now ?? new Date()).toISOString().slice(0, 10);
}

// Resuelve la empresa según el rol. Devuelve un Enterprise_id o lanza 400/403.
function resolveEnterpriseId(user, requestedRaw) {
  const requested = parsePositiveInt(requestedRaw, 'enterpriseId');

  if (isAdminDtc(user)) {
    if (requested == null) {
      throw httpError(400, 'Seleccione una empresa para ver el dashboard.');
    }
    return requested;
  }

  if (requested != null && requested !== Number(user?.enterpriseId)) {
    throw httpError(403, 'No tiene permiso para ver el dashboard de otra empresa.');
  }
  if (user?.enterpriseId == null) {
    throw httpError(403, 'El usuario no tiene una empresa asociada.');
  }
  return Number(user.enterpriseId);
}

// Punto de entrada. pantalla: 'resumen' | 'cumplimiento' | 'catalogo' | 'modelo'.
// opts.now permite fijar la fecha actual en los tests.
function resolveFilters(req, pantalla, opts = {}) {
  const spec = SCREEN_FILTERS[pantalla];
  if (!spec) throw new Error(`Pantalla de dashboard desconocida: ${pantalla}`);

  const q = req.query || {};
  const filters = {
    enterpriseId:   null,
    category:       null,
    chain:          null,
    format:         null,
    desde:          null,
    hasta:          null,
    hastaExclusive: null,
  };

  if (spec.empresa)  filters.enterpriseId = resolveEnterpriseId(req.user, q.enterpriseId);
  if (spec.category) filters.category = parsePositiveInt(q.category, 'category');
  if (spec.chain)    filters.chain = parsePositiveInt(q.chain, 'chain');

  if (spec.format && q.format !== undefined && String(q.format).trim() !== '') {
    const f = String(q.format).trim();
    if (f.length > 50) throw httpError(400, 'El filtro "format" es demasiado largo.');
    filters.format = f;
  }

  if (spec.fechas) {
    let hasta = parseIsoDate(q.hasta, 'hasta');
    let desde = parseIsoDate(q.desde, 'desde');
    if (!hasta) hasta = todayIso(opts.now);
    if (!desde) desde = addDays(hasta, -(DEFAULT_DAYS - 1));
    if (desde > hasta) {
      throw httpError(400, 'La fecha "desde" no puede ser posterior a "hasta".');
    }
    filters.desde = desde;
    filters.hasta = hasta;
    filters.hastaExclusive = addDays(hasta, 1);
  }

  return filters;
}

module.exports = {
  resolveFilters,
  resolveEnterpriseId,
  isAdminDtc,
  SCREEN_FILTERS,
  DEFAULT_DAYS,
};
