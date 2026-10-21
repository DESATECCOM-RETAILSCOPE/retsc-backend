// Preferencias personales del usuario autenticado — self-service, separado a propósito de
// userService.js (eso es administración de OTROS usuarios por un Admin, vía PUT /api/users/:id).
// Hoy solo cubre el radio de búsqueda de puntos de venta del mapa (MapScreen.js, antes
// hardcodeado en RADIO_KM=5, 2026-10-21) — queda en su propio servicio para poder sumar más
// preferencias de la app sin mezclarlas con la lógica de administración de usuarios.

const userRepo = require('../repositories/userRepo');

const MIN_RADIUS_KM = 1;
const MAX_RADIUS_KM = 50;

function svcError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function toDTO(row) {
  return {
    customRadiusEnabled: !!row.custom_radius_enabled,
    searchRadiusKm: row.search_radius_km,
  };
}

async function getMyPreferences(userId) {
  const user = await userRepo.findById(userId);
  if (!user) throw svcError('Usuario no encontrado.', 404);
  return toDTO(user);
}

// customRadiusEnabled: si es false, el mobile debe ignorar searchRadiusKm y usar el default
// fijo (5km) — igual se persiste el valor que mandó el usuario, para no perderlo cuando
// vuelva a activar el ajuste (ver migración 016).
async function setMyPreferences(userId, { customRadiusEnabled, searchRadiusKm }) {
  if (typeof customRadiusEnabled !== 'boolean') {
    throw svcError('customRadiusEnabled es requerido y debe ser true/false.', 400);
  }

  const radius = Number(searchRadiusKm);
  if (!Number.isFinite(radius) || radius < MIN_RADIUS_KM || radius > MAX_RADIUS_KM) {
    throw svcError(`searchRadiusKm debe ser un número entre ${MIN_RADIUS_KM} y ${MAX_RADIUS_KM}.`, 400);
  }

  const updated = await userRepo.updatePreferences(userId, {
    customRadiusEnabled,
    searchRadiusKm: Math.round(radius),
  });
  if (!updated) throw svcError('Usuario no encontrado.', 404);
  return toDTO(updated);
}

module.exports = { getMyPreferences, setMyPreferences, MIN_RADIUS_KM, MAX_RADIUS_KM };
