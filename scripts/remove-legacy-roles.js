/**
 * Elimina los roles "Analista" y "Supervisor" (no pertenecen al catálogo de
 * QA sincronizado en scripts/sync-roles-with-qa.js). Ambos ya estaban
 * desactivados (Status=0) pero seguían existiendo como filas en
 * RETSC_OP_ROLES.
 *
 * "Analista" (Role_id=2) tenía 6 usuarios activos en RETSC_OP_USRSXENTERP —
 * hay una FK real (FK_USER_ENTERPRISE_ROLE, NO_ACTION) que bloquea el DELETE
 * mientras existan esas referencias. Se reasignan primero a ADMIN_DTC
 * (decisión explícita confirmada) y luego se borra el rol.
 *
 * "Supervisor" (Role_id=6) no tenía usuarios — se borra directo.
 *
 * Idempotente — puede correrse más de una vez sin error si ya se aplicó.
 * Uso: node scripts/remove-legacy-roles.js [--dry-run]
 */

require('dotenv').config();
const { getPool, sql } = require('../src/config/db');
const roleRepo = require('../src/repositories/roleRepo');

const DRY_RUN = process.argv.includes('--dry-run');

const REASSIGN_FROM_ROLE_ID = 2; // Analista
const REASSIGN_TO_ROLE_ID   = 9; // ADMIN_DTC
const ROLES_TO_DELETE       = [2, 6]; // Analista, Supervisor

const ok   = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const skip = (m) => console.log('  \x1b[90m·\x1b[0m ' + m);

(async () => {
  const pool = await getPool();
  console.log(DRY_RUN ? '=== DRY RUN — no se escribe nada ===\n' : '=== Aplicando cambios ===\n');

  // ── 1. Reasignar usuarios de Analista → ADMIN_DTC ──────────────────────
  const affected = await pool.request()
    .input('roleId', sql.Int, REASSIGN_FROM_ROLE_ID)
    .query(`SELECT User_id, Enterprise_id FROM RETSC_OP_USRSXENTERP WHERE Role_id = @roleId`);

  if (affected.recordset.length === 0) {
    skip(`Ningún usuario con Role_id=${REASSIGN_FROM_ROLE_ID} — nada que reasignar.`);
  } else {
    console.log(`  ${affected.recordset.length} relación(es) con Role_id=${REASSIGN_FROM_ROLE_ID} → se reasignan a Role_id=${REASSIGN_TO_ROLE_ID}:`);
    console.table(affected.recordset);
    if (!DRY_RUN) {
      await pool.request()
        .input('fromRole', sql.Int, REASSIGN_FROM_ROLE_ID)
        .input('toRole',   sql.Int, REASSIGN_TO_ROLE_ID)
        .query(`UPDATE RETSC_OP_USRSXENTERP SET Role_id = @toRole WHERE Role_id = @fromRole`);
      ok(`Reasignados ${affected.recordset.length} usuario(s).`);
    }
  }

  // ── 2. Borrar los roles legacy ──────────────────────────────────────────
  for (const roleId of ROLES_TO_DELETE) {
    const role = await roleRepo.findById(roleId);
    if (!role) {
      skip(`Role_id=${roleId} ya no existe — nada que borrar.`);
      continue;
    }
    const remaining = await pool.request()
      .input('roleId', sql.Int, roleId)
      .query(`SELECT COUNT(*) AS n FROM RETSC_OP_USRSXENTERP WHERE Role_id = @roleId`);
    const n = remaining.recordset[0].n;
    if (n > 0) {
      console.log(`  \x1b[31m✗\x1b[0m Role_id=${roleId} ("${role.Role_name}") todavía tiene ${n} relación(es) — NO se borra (correr sin --dry-run el paso 1 primero, o revisar).`);
      continue;
    }
    console.log(`  Role_id=${roleId} ("${role.Role_name}") — 0 relaciones, se borra.`);
    if (!DRY_RUN) {
      await pool.request().input('roleId', sql.Int, roleId).query(`DELETE FROM RETSC_OP_ROLES WHERE Role_id = @roleId`);
      ok(`Role_id=${roleId} borrado.`);
    }
  }

  console.log('\n=== Estado final de RETSC_OP_ROLES ===');
  const all = await roleRepo.listAll();
  console.table(all.map(r => ({ Role_id: r.Role_id, Role_name: r.Role_name, Status: r.Status })));

  process.exit(0);
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
