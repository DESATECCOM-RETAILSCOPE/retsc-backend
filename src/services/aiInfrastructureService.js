// Orquestador de infraestructura IA para categorías smart DTC.
//
// Responsabilidad: cuando se crea (o actualiza a smart) una categoría con is_smart_dtc=1,
// este servicio aprovisiona automáticamente:
//   1. Un prefijo en Azure Blob Storage ('global-sku-training/dtc-{slug}/') con archivo .keep
//   2. Registro del container en RETSC_INF_GLOBAL_BLOB_CONTAINERS (solo la primera vez;
//      el container es compartido, tiene UNIQUE constraint por container_name)
//   3. Un registro placeholder en RETSC_AI_DETECTION_MODELS con status PENDING (uno por categoría)
//   4. (Futuro) Un proyecto de Custom Vision — actualmente siempre PENDING
//
// Diseño del storage:
//   - Azure container: 'global-sku-training' (uno global, compartido por todas las categorías smart)
//   - Prefix por categoría: 'dtc-{slug}/' (ej. 'dtc-shampoo/')
//   - RETSC_INF_GLOBAL_BLOB_CONTAINERS: registra el container una sola vez (UNIQUE en container_name)
//   - RETSC_AI_DETECTION_MODELS: un registro por categoría; model_name codifica el prefix
//
// Tolerancia a fallos:
//   - NUNCA lanza excepciones por errores de Azure. Devuelve { status, errors[] }.
//   - Si Blob falla → registro DB con status='PENDING_AZURE' para reintentar.
//   - Si Custom Vision no está configurado → modelo queda PENDING (comportamiento normal).
//
// Reintento: POST /api/categories/:id/retry-ai-infra → retryForCategory()

const categoryRepo              = require('../repositories/categoryRepo');
const globalBlobContainerRepo   = require('../repositories/globalBlobContainerRepo');
const aiModelRepo               = require('../repositories/aiModelRepo');
const blobStorageService        = require('./blobStorageService');
const customVisionService       = require('./customVisionService');
const { normalizeName }         = require('../utils/categoryNameNormalizer');

function getTrainingContainer() {
  return process.env.AZURE_GLOBAL_TRAINING_CONTAINER || 'global-sku-training';
}

// ─── Paso de Blob: marker + registro de container ─────────────────────────────
//
// El container 'global-sku-training' es COMPARTIDO entre todas las categorías smart.
// La tabla RETSC_INF_GLOBAL_BLOB_CONTAINERS tiene UNIQUE en container_name, así que
// el container se registra solo una vez. Si ya existe, solo se crea el marker del prefix.
async function provisionBlobForCategory({ categoryId, prefix, containerName, errors }) {
  // Crear el marker .keep en el prefix (idempotente: no hace nada si ya existe)
  try {
    await blobStorageService.createMarker({ containerName, prefix });
  } catch (err) {
    errors.push(`Blob marker: ${err.message}`);
    // El marker no se pudo crear, pero seguimos para registrar en DB con status PENDING_AZURE
  }

  // Verificar si el container ya está registrado (UNIQUE constraint en container_name)
  const existingContainer = await globalBlobContainerRepo.findByContainerName(containerName);

  if (!existingContainer) {
    // Primera categoría en usar este container: registrar en DB
    const blobStatus = errors.some(e => e.startsWith('Blob marker')) ? 'PENDING_AZURE' : 'ACTIVE';
    await globalBlobContainerRepo.insert({
      categoryId,
      containerName,
      containerType:  'GLOBAL_TRAINING',
      // TODO: extraer el nombre de la cuenta del AZURE_STORAGE_CONNECTION_STRING en lugar de hardcodear.
      storageAccount: 'storagescopeprod',
      prefix,
      description:    '',
      status:         blobStatus,
    });
  }
  // Si ya existe el container, no insertamos nada (UNIQUE constraint).
  // El prefix de esta categoría queda trazado solo en RETSC_AI_DETECTION_MODELS.model_name.
}

// ─── Provisioning completo ────────────────────────────────────────────────────

// Aprovisiona infraestructura IA para una categoría smart DTC.
//
// Retorna: { status: 'PROVISIONED' | 'PENDING' | 'ALREADY_EXISTS', errors: string[] }
//   - PROVISIONED:    todo exitoso
//   - PENDING:        registros creados pero algo de Azure falló → retry disponible
//   - ALREADY_EXISTS: ya tenía model record (idempotente)
//
// Llamar en fire-and-forget desde categoryService — NO bloquea la respuesta HTTP.
const provisionForCategory = async ({ categoryId, categoryName }) => {
  const errors = [];
  const containerName = getTrainingContainer();

  // 1. Verificar que la categoría exista y tenga is_smart_dtc = 1
  const cat = await categoryRepo.findById(categoryId);
  if (!cat) return { status: 'ERROR', errors: [`Categoría ${categoryId} no encontrada`] };
  if (!cat.is_smart_dtc) return { status: 'ERROR', errors: [`Categoría ${categoryId} no es smart DTC`] };

  // 2. Idempotencia: si ya tiene modelo IA, no hacer nada
  const existingModel = await aiModelRepo.findByCategoryId(categoryId);
  if (existingModel) return { status: 'ALREADY_EXISTS', errors: [] };

  // 3. Generar slug/prefix
  const slug   = normalizeName(categoryName);
  const prefix = `dtc-${slug}`;

  // 4. Blob: marker + registro de container (solo si no existe ya)
  await provisionBlobForCategory({ categoryId, prefix, containerName, errors });

  // 5. Modelo IA placeholder
  const model = await aiModelRepo.insert({
    categoryId,
    modelName: `${prefix}-v1`,
    status:    'PENDING',
  });

  // 6. Custom Vision (stub: siempre devuelve null hasta que lleguen las credenciales)
  if (customVisionService.isConfigured()) {
    try {
      const project = await customVisionService.createProject(`${prefix}-v1`);
      if (project) {
        await aiModelRepo.updateCustomVisionRefs(model.detection_model_id, {
          customvisionProjectId: project.id,
          predictionResourceId:  process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID || null,
        });
        await aiModelRepo.updateStatus(model.detection_model_id, 'READY');
      }
    } catch (err) {
      errors.push(`Custom Vision: ${err.message}`);
    }
  }

  return { status: errors.length === 0 ? 'PROVISIONED' : 'PENDING', errors };
};

// ─── Reintento manual ────────────────────────────────────────────────────────

// Reintenta pasos pendientes de infraestructura para una categoría smart DTC.
// Llamado desde POST /api/categories/:id/retry-ai-infra (solo Admin).
const retryForCategory = async (categoryId) => {
  const errors = [];
  const containerName = getTrainingContainer();

  const cat = await categoryRepo.findById(categoryId);
  if (!cat) return { status: 'ERROR', errors: [`Categoría ${categoryId} no encontrada`] };
  if (!cat.is_smart_dtc) return { status: 'ERROR', errors: [`Categoría ${categoryId} no es smart DTC`] };

  const slug   = normalizeName(cat.Category_dsc);
  const prefix = `dtc-${slug}`;

  // ── Modelo IA ────────────────────────────────────────────────────────────
  const existingModel = await aiModelRepo.findByCategoryId(categoryId);

  if (!existingModel) {
    // No existe modelo: provisionar completo
    return provisionForCategory({ categoryId, categoryName: cat.Category_dsc });
  }

  // Reintentar blob marker si el prefijo específico no existe en Azure.
  // NOTA: no verificamos el status del container (compartido entre todas las categorías)
  // sino si el blob de ESTA categoría fue creado — porque el container puede estar ACTIVE
  // para otra categoría aunque este prefijo nunca se haya subido.
  const prefixAlreadyExists = await blobStorageService.prefixExists({ containerName, prefix });
  if (!prefixAlreadyExists) {
    try {
      await blobStorageService.createMarker({ containerName, prefix });
    } catch (err) {
      errors.push(`Blob marker: ${err.message}`);
    }
  }

  // Reintentar Custom Vision si el modelo sigue PENDING
  if (existingModel.status === 'PENDING' && customVisionService.isConfigured()) {
    try {
      const project = await customVisionService.createProject(`${prefix}-v1`);
      if (project) {
        await aiModelRepo.updateCustomVisionRefs(existingModel.detection_model_id, {
          customvisionProjectId: project.id,
          predictionResourceId:  process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID || null,
        });
        await aiModelRepo.updateStatus(existingModel.detection_model_id, 'READY');
      }
    } catch (err) {
      errors.push(`Custom Vision: ${err.message}`);
    }
  }

  if (errors.length === 0) return { status: 'ALREADY_EXISTS', errors: [] };
  return { status: 'PENDING', errors };
};

module.exports = { provisionForCategory, retryForCategory };
