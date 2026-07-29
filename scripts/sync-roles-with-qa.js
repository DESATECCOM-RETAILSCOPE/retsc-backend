/**
 * Sincroniza el nombre/descripción de roles en producción con el catálogo
 * vigente de QA (RETSC_OP_ROLES), sin renumerar Role_id — evita tocar las
 * relaciones existentes en RETSC_OP_USRSXENTERP (24 usuarios en Admin,
 * 1 en Auditor de Campo al momento de escribir esto).
 *
 * Contexto: prod y QA tenían catálogos de roles completamente distintos
 * (nombres, descripciones y cantidad de filas). Se confirmó con el equipo
 * que el catálogo de QA es el vigente. "Analista" (6 usuarios activos, sin
 * equivalente en QA) se mantiene tal cual por decisión explícita — no es
 * parte del catálogo de QA pero no se elimina ni renombra. "Supervisor"
 * (0 usuarios) se desactiva en vez de borrarse.
 *
 * Idempotente — puede correrse más de una vez sin duplicar cambios.
 * Uso: node scripts/sync-roles-with-qa.js [--dry-run]
 */

require('dotenv').config();
const roleRepo = require('../src/repositories/roleRepo');

const DRY_RUN = process.argv.includes('--dry-run');

// Role_id fijo — solo se actualiza Role_name/Description (y Status para Supervisor).
const RENAMES = [
  { roleId: 1, newName: 'ADMIN',           newDescription: 'Rol para administración enterprise' },
  { roleId: 4, newName: 'AUDITOR CAMPO',    newDescription: 'Rol para evaluadores de campo' },
  { roleId: 7, newName: 'GERENCIA',         newDescription: 'Rol para gerencias y mandos medios' },
  { roleId: 8, newName: 'EJECUTIVO CAMPO',  newDescription: 'Rol para administración equipos campo' },
  { roleId: 9, newName: 'ADMIN_DTC',        newDescription: 'Rol para administración DTC total' },
];

const DEACTIVATE = [6]; // Supervisor — 0 usuarios asignados, se desactiva sin borrar.

const ok   = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const skip = (m) => console.log('  \x1b[90m·\x1b[0m ' + m);

(async () => {
  console.log(DRY_RUN ? '=== DRY RUN — no se escribe nada ===\n' : '=== Aplicando cambios ===\n');

  for (const { roleId, newName, newDescription } of RENAMES) {
    const current = await roleRepo.findById(roleId);
    if (!current) {
      console.log(`  \x1b[31m✗\x1b[0m Role_id=${roleId} no existe — se esperaba encontrarlo. Abortando este item.`);
      continue;
    }
    if (current.Role_name === newName && current.Description === newDescription) {
      skip(`Role_id=${roleId} ya está en "${newName}" — sin cambios.`);
      continue;
    }
    console.log(`  Role_id=${roleId}: "${current.Role_name}" → "${newName}"`);
    if (!DRY_RUN) {
      await roleRepo.update(roleId, { Role_name: newName, Description: newDescription });
    }
    ok(`Role_id=${roleId} actualizado.`);
  }

  for (const roleId of DEACTIVATE) {
    const current = await roleRepo.findById(roleId);
    if (!current) {
      console.log(`  \x1b[31m✗\x1b[0m Role_id=${roleId} no existe.`);
      continue;
    }
    if (current.Status === false || current.Status === 0) {
      skip(`Role_id=${roleId} ("${current.Role_name}") ya está desactivado.`);
      continue;
    }
    console.log(`  Role_id=${roleId} ("${current.Role_name}"): Status 1 → 0`);
    if (!DRY_RUN) {
      await roleRepo.update(roleId, { Status: 0 });
    }
    ok(`Role_id=${roleId} desactivado.`);
  }

  console.log('\n=== Estado final ===');
  const all = await roleRepo.listAll();
  console.table(all.map(r => ({ Role_id: r.Role_id, Role_name: r.Role_name, Status: r.Status })));

  process.exit(0);
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
