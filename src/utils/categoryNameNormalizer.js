// Convierte un nombre de categoría a un slug válido para usar como prefijo en Azure Blob Storage.
//
// Reglas aplicadas en orden:
//   1. Minúsculas
//   2. Elimina acentos y ñ  (NFD + strip diacríticos + ñ→n)
//   3. Caracteres que no son a-z, 0-9 ni espacios → guión
//   4. Colapsa guiones/espacios consecutivos en uno solo
//   5. Elimina guiones al inicio y al final
//   6. Recorta a 50 caracteres máx (límite de nombres de blob razonables)
//
// Ejemplos:
//   'Shampoo'                → 'shampoo'
//   'Vino Tinto'             → 'vino-tinto'
//   'Cuidado del Cabello'    → 'cuidado-del-cabello'
//   'Frutas & Verduras'      → 'frutas-verduras'
//   'Crémas & Champús (Cosméticos)' → 'cremas-champus-cosmeticos'

function normalizeName(name) {
  if (!name || typeof name !== 'string') return 'sin-nombre';

  return name
    .toLowerCase()
    // Descompone caracteres acentuados (é→e+´) y elimina los diacríticos
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // ñ no siempre se normaliza completamente con NFD, manejarlo explícitamente
    .replace(/ñ/g, 'n')
    // Cualquier carácter que no sea letra, dígito o espacio → guión
    .replace(/[^a-z0-9\s]/g, '-')
    // Espacios → guión
    .replace(/\s+/g, '-')
    // Colapsar guiones consecutivos
    .replace(/-{2,}/g, '-')
    // Eliminar guiones al inicio y al final
    .replace(/^-+|-+$/g, '')
    // Límite de longitud para nombres de blob
    .slice(0, 50)
    // Puede quedar guión al final si se cortó en medio de una palabra
    .replace(/-+$/, '')
    // Si quedó vacío (nombre raro), fallback
    || 'sin-nombre';
}

module.exports = { normalizeName };

// ─── Tests de autovalidación (solo al ejecutar directamente) ─────────────────
// Ejecutar con: node src/utils/categoryNameNormalizer.js
if (require.main === module) {
  const casos = [
    ['Shampoo',                         'shampoo'],
    ['Vino Tinto',                      'vino-tinto'],
    ['Cuidado del Cabello',             'cuidado-del-cabello'],
    ['Frutas & Verduras',               'frutas-verduras'],
    ['Crémas & Champús (Cosméticos)',   'cremas-champus-cosmeticos'],
    ['  --  espacios raros  --  ',      'espacios-raros'],
    ['Ñoño & Güisqui',                  'nono-guisqui'],
    ['',                                'sin-nombre'],
  ];

  let ok = 0;
  for (const [input, expected] of casos) {
    const result = normalizeName(input);
    const pass = result === expected;
    console.log(`${pass ? '✓' : '✗'} '${input}' → '${result}'${pass ? '' : ` (esperado: '${expected}')`}`);
    if (pass) ok++;
  }
  console.log(`\n${ok}/${casos.length} tests pasados.`);
}
