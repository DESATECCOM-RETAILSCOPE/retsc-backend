// Corre una migración .sql desde la terminal (alternativa a SSMS).
//
// Separa el archivo en lotes por las líneas "GO" (como SSMS) y los ejecuta EN ORDEN dentro de
// UNA transacción: si un lote falla, se hace ROLLBACK de todo y la base queda como estaba.
// Los lotes que son solo comentarios (ej. pasos opcionales comentados) se saltan.
//
// Uso (desde la raíz de Back End, con el .env del ambiente):
//   node scripts/correr-migracion.js migrations/020_planogram_flow_direction.sql
//       → SOLO LECTURA: muestra la base a la que apunta, corre el paso 0 (diagnóstico) y lista
//         los lotes que se ejecutarían. No cambia nada.
//   node scripts/correr-migracion.js migrations/020_planogram_flow_direction.sql --aplicar --base=sqldb-rscope-qa
//       → ejecuta todos los lotes. --base tiene que coincidir con SQL_DATABASE del .env
//         (protección para no correrla en otra base por error).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool, sql } = require('../src/config/db');

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--'));
const aplicar = args.includes('--aplicar');
const base = (args.find((a) => a.startsWith('--base=')) || '').slice(7);

if (!archivo || !fs.existsSync(archivo)) {
  console.error('Uso: node scripts/correr-migracion.js <archivo.sql> [--aplicar --base=<SQL_DATABASE>]');
  process.exit(1);
}

const soloComentarios = (lote) => lote.split('\n').every((l) => !l.trim() || l.trim().startsWith('--'));
const lotes = fs.readFileSync(archivo, 'utf8')
  .split(/^\s*GO\s*$/im)
  .map((l) => l.trim())
  .filter((l) => l && !soloComentarios(l));
const titulo = (lote) => (lote.split('\n').find((l) => /^--\s*\d+\)/.test(l.trim())) || lote.split('\n').find((l) => l.trim() && !l.trim().startsWith('--')) || '').trim().slice(0, 90);

function mostrar(result) {
  for (const rs of result.recordsets || []) {
    if (rs.length) console.table(rs); else console.log('   (sin filas)');
  }
}

(async () => {
  console.log(`\nMigración: ${path.basename(archivo)}`);
  console.log(`Base (SQL_DATABASE): ${process.env.SQL_DATABASE} en ${process.env.SQL_SERVER}`);
  console.log(`Lotes a ejecutar: ${lotes.length}`);
  lotes.forEach((l, i) => console.log(`   ${i + 1}. ${titulo(l)}`));

  const pool = await getPool();

  if (!aplicar) {
    console.log('\n── Paso 0 (solo lectura) ──');
    mostrar(await pool.request().query(lotes[0]));
    console.log('\nNo se cambió nada. Para aplicar:');
    console.log(`   node scripts/correr-migracion.js ${archivo} --aplicar --base=${process.env.SQL_DATABASE}`);
    process.exit(0);
  }

  if (!base || base !== process.env.SQL_DATABASE) {
    console.error(`\n✖ --base=${base || '(vacío)'} no coincide con SQL_DATABASE=${process.env.SQL_DATABASE}. No se ejecutó nada.`);
    process.exit(1);
  }

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (let i = 0; i < lotes.length; i++) {
      console.log(`\n── Lote ${i + 1}/${lotes.length}: ${titulo(lotes[i])}`);
      mostrar(await new sql.Request(tx).query(lotes[i]));
    }
    await tx.commit();
    console.log('\n✔ COMMIT — migración aplicada.');
    process.exit(0);
  } catch (err) {
    await tx.rollback().catch(() => {});
    console.error(`\n✖ Error: ${err.message}`);
    console.error('ROLLBACK — no quedó ningún cambio.');
    process.exit(1);
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
