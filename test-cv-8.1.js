// Script de prueba para Issue 8.1 — ejecutar: node test-cv-8.1.js
// Crea un proyecto Object Detection en Custom Vision y lo elimina al final.

require('dotenv').config();

async function main() {
  const cv = require('./src/services/customVisionService');

  console.log('isConfigured:', cv.isConfigured());
  if (!cv.isConfigured()) {
    console.error('CUSTOM_VISION_TRAINING_KEY o CUSTOM_VISION_ENDPOINT no están en .env');
    process.exit(1);
  }

  const testName = `test-8.1-${Date.now()}`;
  console.log(`Creando proyecto "${testName}"...`);

  let project;
  try {
    project = await cv.createProject(testName);
    console.log('Proyecto creado:', project);
  } catch (err) {
    console.error('ERROR al crear proyecto:', err.message);
    process.exit(1);
  }

  if (!project || !project.id || !project.name) {
    console.error('Respuesta inesperada:', project);
    process.exit(1);
  }

  // Verificar en la lista de proyectos del recurso
  const { TrainingAPIClient } = require('@azure/cognitiveservices-customvision-training');
  const { ApiKeyCredentials }  = require('@azure/ms-rest-js');
  const client = new TrainingAPIClient(
    new ApiKeyCredentials({ inHeader: { 'Training-key': process.env.CUSTOM_VISION_TRAINING_KEY } }),
    process.env.CUSTOM_VISION_ENDPOINT
  );

  const projects = await client.getProjects();
  const found = projects.find(p => p.id === project.id);
  if (!found) {
    console.error('Proyecto no encontrado en la lista del recurso.');
    process.exit(1);
  }
  console.log('Verificado en Azure:', { id: found.id, name: found.name, settings: found.settings });

  // Limpiar
  try {
    await client.deleteProject(project.id);
    console.log(`Proyecto "${testName}" eliminado.`);
  } catch (err) {
    console.warn('No se pudo eliminar el proyecto de prueba (borralo manualmente):', err.message);
  }

  console.log('\n✓ Issue 8.1 OK — createProject() funciona con Object Detection.');
}

main().catch(err => {
  console.error('Error inesperado:', err.message || err);
  process.exit(1);
});
