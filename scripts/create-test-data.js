/**
 * Genera test-data/products.xlsx y test-data/images/*.jpg para probar el pipeline.
 * Uso: node scripts/create-test-data.js
 */
const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const EXCEL_PATH = path.join(ROOT, 'test-data', 'products.xlsx');
const IMAGES_DIR = path.join(ROOT, 'test-data', 'images');

// GTINs válidos verificados con algoritmo GS1 Mod 10
const products = [
  { GTIN: '7501031311309', Description: 'Chips Originales 100g',   Category: 'Snacks',    Subcategory: 'Papas Fritas', Segment: 'Original',  Brand: 'Barcel'     },
  { GTIN: '7501031318100', Description: 'Chips Chile Limón 100g',  Category: 'Snacks',    Subcategory: 'Papas Fritas', Segment: 'Chile',     Brand: 'Barcel'     },
  { GTIN: '036000291452',  Description: "Campbell's Soup 305g",    Category: 'Abarrotes', Subcategory: 'Sopas',        Segment: 'Enlatados', Brand: "Campbell's" },
  { GTIN: '96385074',      Description: 'Jabón Líquido 500ml',     Category: 'Limpieza',  Subcategory: 'Jabones',      Segment: 'Líquidos',  Brand: 'Demo'       },
  { GTIN: '7501234567893', Description: 'Agua Mineral 1.5L',       Category: 'Bebidas',   Subcategory: 'Aguas',        Segment: 'Mineral',   Brand: 'Demo'       },
  // GTINs inválidos — deben ser rechazados por el validador
  { GTIN: '7501031311300', Description: 'GTIN Inválido 1',         Category: 'Bebidas',   Subcategory: 'Prueba',       Segment: 'Prueba',    Brand: 'Demo'       },
  { GTIN: '1234567890123', Description: 'GTIN Inválido 2',         Category: 'Snacks',    Subcategory: 'Prueba',       Segment: 'Prueba',    Brand: 'Demo'       },
];

// Genera un buffer único por imagen agregando el GTIN como comentario en los bytes
function makeUniqueImage(label) {
  // PNG 1x1 rojo con un comentario que lo hace único
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');           // PNG signature
  const ihdr = Buffer.from('0000000d494844520000000100000001080200000090'
    + 'wc3b', 'hex').slice(0, 25);                                      // IHDR chunk
  // usamos un buffer de texto único como payload
  return Buffer.concat([signature, Buffer.from(`IMG:${label}:`)]);
}

function main() {
  fs.mkdirSync(path.join(ROOT, 'test-data'), { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // Excel
  const ws = XLSX.utils.json_to_sheet(products);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Productos');
  XLSX.writeFile(wb, EXCEL_PATH);
  console.log(`Excel creado: ${EXCEL_PATH} (${products.length} filas)`);

  // Imágenes con contenido ÚNICO por archivo (diferente hash)
  // 3 de las 5 válidas → 2 productos quedan sin imagen
  const imageGtins = ['7501031311309', '7501031318100', '036000291452'];
  for (const gtin of imageGtins) {
    const imgPath = path.join(IMAGES_DIR, `${gtin}.jpg`);
    fs.writeFileSync(imgPath, makeUniqueImage(gtin));
    console.log(`Imagen creada: ${imgPath}`);
  }

  // Imagen extra sin match (GTIN no está en el Excel)
  const extraPath = path.join(IMAGES_DIR, '9999999999999_extra.jpg');
  fs.writeFileSync(extraPath, makeUniqueImage('9999999999999_extra'));
  console.log(`Imagen sin match creada: ${extraPath}`);

  console.log('\nDatos de prueba listos en test-data/');
  console.log('  - products.xlsx: 5 GTINs válidos + 2 inválidos');
  console.log('  - images/: 3 imágenes con match + 1 sin match');
}

main();
