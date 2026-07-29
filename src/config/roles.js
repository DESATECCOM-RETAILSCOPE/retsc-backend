// Catálogo canónico de roles (Role_name en RETSC_OP_ROLES). Toda comparación de
// rol en el código debe usar estas constantes + normalizeRole — nunca un string
// literal, y nunca Role_id (varía entre ambientes: prod 1-5, QA 1,4,7,8,9).
//
// Origen: feedback de la dueña del proyecto (1 Jul) tras el rename de roles a
// mayúsculas (scripts/sync-roles-with-qa.js) — los middlewares comparaban con
// los nombres legacy ('Admin', 'Supervisor') de forma case-sensitive y exacta,
// dejando a todo ADMIN real sin acceso (403).

const ROLES = Object.freeze({
  ADMIN:           'ADMIN',
  ADMIN_DTC:       'ADMIN_DTC',
  EJECUTIVO_CAMPO: 'EJECUTIVO CAMPO',
  GERENCIA:        'GERENCIA',
  AUDITOR_CAMPO:   'AUDITOR CAMPO',
});

// trim + mayúsculas — usar en ambos lados de cualquier comparación de rol.
function normalizeRole(name) {
  return String(name ?? '').trim().toUpperCase();
}

module.exports = { ROLES, normalizeRole };
