// Orquestador de infraestructura IA para categorías smart DTC.
//
// Responsabilidad: cuando se crea (o actualiza a smart) una categoría con is_smart_dtc=1,
// este servicio aprovisiona automáticamente:
//   1. Un prefijo en Azure Blob Storage ('global-sku-training/dtc-{slug}/') con archivo .keep
//   2. Los 3 prefijos por canal en 'global-shelf-training' ('dtc-{slug}/omt|dtt|convenience/')
//      con archivo .keep — agregado junto con la migración 007 (antes no se creaba nada acá)
//   3. Registro de cada prefix en RETSC_INF_GLOBAL_BLOB_CONTAINERS (una fila por
//      combinación container_name+prefix, ver migración 007 — antes el UNIQUE era solo
//      sobre container_name y bloqueaba el registro de cualquier categoría que no fuera
//      la primera en usar ese container)
//   4. Un registro placeholder en RETSC_AI_DETECTION_MODELS con status PENDING (uno por categoría)
//   5. (Futuro) Un proyecto de Custom Vision — actualmente siempre PENDING
//
// Diseño del storage:
//   - Azure containers: 'global-sku-training' (fotos de SKU) y 'global-shelf-training'
//     (fotos de góndola) — ambos compartidos por todas las categorías smart
//   - Prefix SKU:   'dtc-{slug}/' (ej. 'dtc-shampoo/')
//   - Prefix góndola: 'dtc-{slug}/{omt|dtt|convenience}/' (ej. 'dtc-shampoo/omt/')
//   - RETSC_INF_GLOBAL_BLOB_CONTAINERS: una fila por (container_name, prefix) — UNIQUE compuesto
//   - RETSC_AI_DETECTION_MODELS: un registro por categoría; model_name codifica el prefix SKU
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

const CANALES = ['omt', 'dtt', 'convenience'];

// Tipos válidos de container_type (CHK_RETSC_GLOBAL_BLOB_TYPE): solo existen estos 2
// valores, uno por cada container global — ver header de globalBlobContainerRepo.js.
const CONTAINER_TYPE_SKU_PHOTOS = 'GLOBAL_SKU_PHOTOS';
const CONTAINER_TYPE_SHELF_TRAINING = 'GLOBAL_TRAINING';

function getTrainingContainer() {
  return process.env.AZURE_GLOBAL_TRAINING_CONTAINER || 'global-sku-training';
}

function getShelfContainer() {
  return process.env.AZURE_GLOBAL_SHELF_CONTAINER || 'global-shelf-training';
}

// BUG (encontrado en prueba E2E, 2026-07-19): RETSC_AI_DETECTION_MODELS.prediction_resource_id
// es VARCHAR(100), pero un Azure Resource ID completo (/subscriptions/.../resourceGroups/.../
// providers/Microsoft.CognitiveServices/accounts/{nombre}) fácilmente supera esa longitud —
// en este ambiente mide 122 caracteres. Enviarlo tal cual rompe el protocolo TDS del UPDATE
// ("Data type 0xA7 has an invalid data length or metadata length"), y como updateCustomVisionRefs
// se llama DESPUÉS de crear el proyecto real en Custom Vision, el resultado es un proyecto CV
// huérfano: existe en Azure pero customvision_project_id nunca queda guardado en la fila.
// No se trunca el valor (quedaría un Resource ID inválido y parecería válido) — se guarda null
// y se loguea la advertencia. Ampliar la columna es una migración de estructura, fuera de
// alcance acá; hacerlo si en el futuro se necesita el valor completo persistido.
function getSafePredictionResourceId() {
  const raw = process.env.CUSTOM_VISION_PREDICTION_RESOURCE_ID || null;
  if (raw && raw.length > 100) {
    console.warn(`[aiInfra] CUSTOM_VISION_PREDICTION_RESOURCE_ID mide ${raw.length} caracteres, excede prediction_resource_id VARCHAR(100) — se guarda NULL en vez de truncar.`);
    return null;
  }
  return raw;
}

// ─── Paso de Blob: marker + registro de container ─────────────────────────────
//
// Los containers ('global-sku-training', 'global-shelf-training') son COMPARTIDOS entre
// todas las categorías smart. Desde la migración 007, RETSC_INF_GLOBAL_BLOB_CONTAINERS
// tiene UNIQUE en (container_name, prefix) — no en container_name solo — así que cada
// categoría (y cada canal, en el caso de góndola) SÍ queda registrada con su propia fila,
// aunque comparta container_name con otras.
async function provisionBlobForCategory({ categoryId, prefix, containerName, containerType, errors }) {
  // Crear el marker .keep en el prefix (idempotente: no hace nada si ya existe)
  try {
    await blobStorageService.createMarker({ containerName, prefix });
  } catch (err) {
    errors.push(`Blob marker (${prefix}): ${err.message}`);
    // El marker no se pudo crear, pero seguimos para registrar en DB con status PENDING_AZURE
  }

  // Verificar si esta combinación container_name+prefix ya está registrada (UNIQUE compuesto)
  const existingRecord = await globalBlobContainerRepo.findByName(containerName, prefix);

  if (!existingRecord) {
    // BUG (encontrado en prueba E2E, 2026-07-19; UNIQUE compuesto agregado en migración 007):
    // con varias categorías/canales provisionando en paralelo (fire-and-forget), dos podían
    // pasar el chequeo de existencia antes de que la primera hiciera commit, y la segunda
    // chocaba contra la UNIQUE constraint. Como categoryService.js llama a
    // provisionForCategory().then(...) sin .catch(), esa excepción sin capturar abortaba TODO
    // el resto del provisioning de esa categoría (ni siquiera llegaba a crear su fila en
    // RETSC_AI_DETECTION_MODELS). Se mantiene el try/catch por la misma razón, aunque ahora
    // la carrera solo puede darse si dos categorías/canales usan EXACTAMENTE el mismo prefix.
    try {
      const blobStatus = errors.some(e => e.startsWith('Blob marker')) ? 'PENDING_AZURE' : 'ACTIVE';
      await globalBlobContainerRepo.insert({
        categoryId,
        containerName,
        containerType,
        // TODO: extraer el nombre de la cuenta del AZURE_STORAGE_CONNECTION_STRING en lugar de hardcodear.
        storageAccount: 'storagescopeprod',
        prefix,
        description:    '',
        status:         blobStatus,
      });
    } catch (err) {
      // Error 2627/2601 de SQL Server = violación de UNIQUE constraint — significa que otro
      // provisioning en paralelo ganó la carrera para esta MISMA combinación container+prefix;
      // no es un error real, es el mismo caso que existingRecord ya intentaba prevenir.
      // Cualquier otro error sí se registra.
      if (err.number === 2627 || err.number === 2601) {
        console.log(`[aiInfra] container "${containerName}" prefix "${prefix}" ya fue registrado (carrera de provisioning en paralelo) — se ignora.`);
      } else {
        errors.push(`Blob container registro (${prefix}): ${err.message}`);
      }
    }
  }
}

// Aprovisiona los 3 prefijos de canal ('omt', 'dtt', 'convenience') en el container de
// fotos de góndola para una categoría. Antes de esto, aiInfrastructureService nunca
// tocaba 'global-shelf-training' — shelfPhotoUploadService creaba el path recién al
// subir la primera foto real, sin marker previo visible en el Portal de Azure.
async function provisionShelfPrefixesForCategory({ categoryId, slug, errors }) {
  const shelfContainer = getShelfContainer();
  for (const canal of CANALES) {
    const prefix = `dtc-${slug}/${canal}`;
    await provisionBlobForCategory({
      categoryId,
      prefix,
      containerName: shelfContainer,
      containerType: CONTAINER_TYPE_SHELF_TRAINING,
      errors,
    });
  }
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

  // 4. Blob SKU: marker + registro de container (solo si no existe ya)
  await provisionBlobForCategory({
    categoryId, prefix, containerName, errors,
    containerType: CONTAINER_TYPE_SKU_PHOTOS,
  });

  // 4b. Blob góndola: los 3 prefijos por canal (omt/dtt/convenience)
  await provisionShelfPrefixesForCategory({ categoryId, slug, errors });

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
          predictionResourceId:  getSafePredictionResourceId(),
        });
        await aiModelRepo.updateStatus(model.detection_model_id, 'PROJECT_CREATED');
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

  // Reintentar registro en RETSC_INF_GLOBAL_BLOB_CONTAINERS por si el insert original
  // falló (mismo chequeo por combinación container_name+prefix que usa provisionForCategory).
  const existingRecord = await globalBlobContainerRepo.findByName(containerName, prefix);
  if (!existingRecord) {
    await provisionBlobForCategory({
      categoryId, prefix, containerName, errors,
      containerType: CONTAINER_TYPE_SKU_PHOTOS,
    });
  }

  // Reintentar los 3 prefijos de góndola (omt/dtt/convenience) — provisionBlobForCategory
  // ya es idempotente por combinación container_name+prefix, así que es seguro llamarla
  // de nuevo aunque algunos canales ya estén provisionados.
  await provisionShelfPrefixesForCategory({ categoryId, slug, errors });

  // Reintentar Custom Vision si el modelo sigue PENDING
  if (existingModel.status === 'PENDING' && customVisionService.isConfigured()) {
    try {
      const project = await customVisionService.createProject(`${prefix}-v1`);
      if (project) {
        await aiModelRepo.updateCustomVisionRefs(existingModel.detection_model_id, {
          customvisionProjectId: project.id,
          predictionResourceId:  getSafePredictionResourceId(),
        });
        await aiModelRepo.updateStatus(existingModel.detection_model_id, 'PROJECT_CREATED');
      }
    } catch (err) {
      errors.push(`Custom Vision: ${err.message}`);
    }
  }

  if (errors.length === 0) return { status: 'ALREADY_EXISTS', errors: [] };
  return { status: 'PENDING', errors };
};

module.exports = { provisionForCategory, retryForCategory };
