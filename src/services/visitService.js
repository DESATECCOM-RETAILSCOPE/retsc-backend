// Servicio para RETSC_EX_VISIT — Paso 0 de la guía "Fotos de Visita" v1.9 (María Royo):
// abrir/cerrar la visita del auditor/gerente en el PDV. Esta fila es la que amarra todo lo
// demás (blob path, RETSC_EX_SHELFPHOTO, y más adelante el cálculo de KPIs — guía sección 1).
//
// enterpriseId SIEMPRE sale de req.user.enterpriseId (JWT), nunca del body — mismo criterio
// de scoping que el resto del repo (ver enterpriseController.js) para que un usuario no
// pueda abrir una visita "a nombre de" otro enterprise.

const visitRepo = require('../repositories/visitRepo');

function svcError(message, statusCode, errorCode) {
  return Object.assign(new Error(message), { statusCode, errorCode });
}

// Mapea la fila MSSQL (Pascal_Case) a camelCase — convención del repo (ver roleService.js).
function toDTO(row) {
  if (!row) return null;
  return {
    visitId:      row.Visit_id,
    userId:       row.User_id,
    enterpriseId: row.Enterprise_id,
    retailerId:   row.Retailer_id,
    visitStart:   row.Visit_start,
    visitEnd:     row.Visit_end,
    latitude:     row.Latitude,
    longitude:    row.Longitude,
    status:       row.Status,
  };
}

// Abre una visita nueva. Devuelve { visitId, ... } — visitId es el identificador que el
// mobile debe reusar en TODOS los pasos siguientes (guía sección 2: "session_id es el
// Visit_id que te devolvió ese INSERT").
//
// NOTA (decisión no explícita en la guía, pero razonable): no se permite abrir una segunda
// visita mientras el usuario ya tiene una OPEN — evita visitas huérfanas por doble-tap o
// reconexión del mobile. Si el negocio necesita visitas concurrentes por usuario, quitar
// este chequeo es trivial (una sola condición abajo).
async function openVisit({ userId, enterpriseId, retailerId, latitude, longitude }) {
  if (!retailerId || isNaN(parseInt(retailerId, 10))) {
    throw svcError('retailerId es requerido y debe ser un número entero (el PDV seleccionado).', 400, 'ERR_RETAILER_REQUERIDO');
  }

  const openVisits = await visitRepo.findOpenByUser(userId);
  if (openVisits.length > 0) {
    throw svcError(
      `Ya existe una visita abierta (Visit_id=${openVisits[0].Visit_id}). Ciérrala antes de abrir una nueva.`,
      409, 'ERR_VISITA_YA_ABIERTA'
    );
  }

  const row = await visitRepo.open({
    userId,
    enterpriseId,
    retailerId: parseInt(retailerId, 10),
    latitude,
    longitude,
  });
  return toDTO(row);
}

// Cierra una visita (guía sección 2, callout "Cerrar la visita" — "el momento natural para
// disparar cualquier procesamiento pendiente de esa visita"). Solo el usuario dueño de la
// visita (o un rol admin) puede cerrarla.
async function closeVisit(visitId, { userId, isAdmin = false }) {
  const visit = await visitRepo.findById(visitId);
  if (!visit) {
    throw svcError(`Visita ${visitId} no encontrada.`, 404, 'ERR_VISITA_NO_ENCONTRADA');
  }
  if (!isAdmin && visit.User_id !== userId) {
    throw svcError('No puedes cerrar una visita de otro usuario.', 403, 'ERR_VISITA_AJENA');
  }
  if (visit.Status !== 'OPEN') {
    throw svcError(`La visita ${visitId} ya está ${visit.Status}.`, 409, 'ERR_VISITA_YA_CERRADA');
  }

  const row = await visitRepo.close(visitId);
  return toDTO(row);
}

async function getVisit(visitId) {
  const row = await visitRepo.findById(visitId);
  if (!row) {
    throw svcError(`Visita ${visitId} no encontrada.`, 404, 'ERR_VISITA_NO_ENCONTRADA');
  }
  return toDTO(row);
}

// Devuelve la visita OPEN del usuario si tiene una, o null. Pensado para que el mobile
// pueda ofrecer "cerrar mi visita abierta" sin tener que conocer su Visit_id de antemano
// (ej. después de recibir el 409 ERR_VISITA_YA_ABIERTA de openVisit, o proactivamente en
// el mapa antes de intentar abrir una nueva).
async function getOpenForUser(userId) {
  const openVisits = await visitRepo.findOpenByUser(userId);
  return openVisits.length > 0 ? toDTO(openVisits[0]) : null;
}

module.exports = { openVisit, closeVisit, getVisit, getOpenForUser };
