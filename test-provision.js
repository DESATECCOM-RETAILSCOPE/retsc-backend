// test-provision.js — diagnóstico del flujo completo de provisioning de una categoría smart
require('dotenv').config();
const { getPool }              = require('./src/config/db');
const aiInfrastructureService  = require('./src/services/aiInfrastructureService');

(async () => {
  const pool = await getPool();

  // 1. Buscar la primera categoría smart existente
  const r = await pool.request().query(`
    SELECT TOP 1 Category_id, Category_dsc, is_smart_dtc
    FROM RETSC_OP_CATEGORIES
    WHERE is_smart_dtc = 1
  `);

  if (r.recordset.length === 0) {
    console.log('⚠ No hay categorías smart en la BD. Creando una de prueba...');

    const ins = await pool.request().query(`
      INSERT INTO RETSC_OP_CATEGORIES (Category_dsc, is_smart_dtc, status)
      OUTPUT INSERTED.Category_id
      VALUES ('Prueba Diagnóstico', 1, 'ACTIVE')
    `);
    const categoryId = ins.recordset[0].Category_id;
    console.log(`  Categoría de prueba creada con ID: ${categoryId}`);

    const result = await aiInfrastructureService.provisionForCategory({
      categoryId,
      categoryName: 'Prueba Diagnóstico',
    });
    console.log('\nResultado provisionForCategory:', JSON.stringify(result, null, 2));

    // Limpiar categoría de prueba
    await pool.request().query(`DELETE FROM RETSC_AI_DETECTION_MODELS WHERE category_id = ${categoryId}`);
    await pool.request().query(`DELETE FROM RETSC_OP_CATEGORIES WHERE Category_id = ${categoryId}`);
    console.log('\n(Categoría de prueba eliminada)');
  } else {
    const cat = r.recordset[0];
    console.log(`Categoría smart encontrada: [${cat.Category_id}] ${cat.Category_dsc}`);

    const result = await aiInfrastructureService.provisionForCategory({
      categoryId: cat.Category_id,
      categoryName: cat.Category_dsc,
    });
    console.log('\nResultado provisionForCategory:', JSON.stringify(result, null, 2));
  }

  process.exit(0);
})().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
