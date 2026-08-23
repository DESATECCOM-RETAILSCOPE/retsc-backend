// Controller del módulo de revisión de anotaciones (Issue 7.5).
// Rutas asociadas: /api/annotations
//
// La autorización por rol (Admin / Supervisor) se aplica en annotationRoutes.js
// con requireRole; aquí solo se asume que req.user ya existe (authMiddleware).

const annotationService     = require('../services/annotationService');
const annotationRepo        = require('../repositories/annotationRepo');
const trainingPhotoRepo     = require('../repositories/trainingPhotoRepo');
const annotationSyncService = require('../services/annotationSyncService');
const blobStorageService    = require('../services/blobStorageService');
const path                  = require('path');

// Container de las fotos de góndola. MISMO valor y default que
// shelfPhotoUploadService.js — NO es AZURE_BLOB_CONTAINER (imágenes de producto)
// ni AZURE_GLOBAL_TRAINING_CONTAINER (imágenes de SKU). Confundirlos hace que la
// descarga busque en el container equivocado y devuelva 404 con el blob existiendo.
const SHELF_CONTAINER = () =>
  process.env.AZURE_GLOBAL_SHELF_CONTAINER || 'global-shelf-training';

// Los blobs se suben con uploadToContainer sin blobHTTPHeaders en algunos casos,
// así que Azure les pone application/octet-stream y el navegador no los renderiza
// como imagen. Se deriva de la extensión.
const CONTENT_TYPE_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png',  '.webp': 'image/webp', '.gif': 'image/gif',
};

// Duplicado deliberado de la misma lista en shelfPhotoUploadService.js /
// annotationSyncService.js — no hay un módulo compartido de constantes de canal
// hoy y no vale la pena crear uno para 3 usos idénticos.
const CANALES_VALIDOS = ['OMT', 'DTT', 'CONVENIENCE'];

// Tope del lote de aprobación. Cada foto implica subir sus cajitas a Custom
// Vision, así que un lote enorme mantendría la petición HTTP abierta minutos y se
// llevaría un timeout del proxy con parte del trabajo ya hecho.
const MAX_BATCH_APPROVE = 50;

function handleError(res, err) {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[annotation]', err);
  return res.status(status).json({ success: false, message: err.message });
}

function parseId(value, label) {
  const id = parseInt(value, 10);
  if (isNaN(id)) throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  return id;
}

// PATCH /api/annotations/:id/approve  — APROBAR
const approve = async (req, res) => {
  try {
    const id = parseId(req.params.id, 'Annotation ID');
    const annotation = await annotationService.approve(id, req.user.userId);
    return res.json({ success: true, annotation });
  } catch (err) {
    return handleError(res, err);
  }
};

// PATCH /api/annotations/:id  — CORREGIR (coordenadas + validar)
// Body: { bbox_left, bbox_top, bbox_width, bbox_height }
const correct = async (req, res) => {
  try {
    const id = parseId(req.params.id, 'Annotation ID');
    const { bbox_left, bbox_top, bbox_width, bbox_height } = req.body;
    const annotation = await annotationService.correct(
      id,
      { bbox_left, bbox_top, bbox_width, bbox_height },
      req.user.userId,
    );
    return res.json({ success: true, annotation });
  } catch (err) {
    return handleError(res, err);
  }
};

// DELETE /api/annotations/:id  — RECHAZAR (eliminar)
const reject = async (req, res) => {
  try {
    const id = parseId(req.params.id, 'Annotation ID');
    const result = await annotationService.reject(id);
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/annotations/photo/:photoId  — listar anotaciones de una foto
const listByPhoto = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const annotations = await annotationRepo.listByPhoto(photoId);
    return res.json({ success: true, annotations });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/annotations/photo/:photoId/readiness  — ¿lista para Custom Vision?
const readiness = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const status = await annotationService.getPhotoReadiness(photoId);
    return res.json({ success: true, ...status });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/annotations/photos — review queue global (Issues 8.2 + menú por rol 2026-07-25).
// listPhotos/getPhotoWithRegions/approvePhoto ya existían en annotationRepo.js sin ninguna
// ruta que las llamara (código muerto documentado en CLAUDE.md como "pendiente de un
// futuro endpoint de review queue") — este es ese endpoint. FIX 2026-07-26: las tres se
// movieron a trainingPhotoRepo.js porque el equipo DBA migró los campos a nivel de foto
// (canal, categoría, estado de aprobación) a la tabla nueva RETSC_AI_TRAINING_PHOTOS — ver
// el header de ese archivo. El contrato de esta ruta no cambió.
// Query params opcionales: categoryId, canal, status. A diferencia de GET /photo/:photoId
// (abierta a cualquier autenticado), esta va gateada por canValidate en las rutas —
// alimenta las pantallas "Anotaciones" (ADMIN_DTC) y "Revisar cajitas" (ADMIN) del menú.
const listPhotos = async (req, res) => {
  try {
    const { categoryId, canal, status } = req.query;

    if (canal && !CANALES_VALIDOS.includes(canal)) {
      return res.status(400).json({
        success: false,
        message: `canal inválido: '${canal}'. Debe ser uno de: ${CANALES_VALIDOS.join(', ')}.`,
      });
    }

    const photos = await trainingPhotoRepo.listPhotos({
      categoryId: categoryId != null ? parseId(categoryId, 'categoryId') : undefined,
      canal,
      status,
    });
    return res.json({ success: true, photos });
  } catch (err) {
    return handleError(res, err);
  }
};

// GET /api/annotations/photos/:photoId — detalle de una foto con todas sus cajitas
const getPhotoDetail = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const photo = await trainingPhotoRepo.getPhotoWithRegions(photoId);
    if (!photo) {
      return res.status(404).json({ success: false, message: `Foto ${photoId} no encontrada.` });
    }
    return res.json({ success: true, photo });
  } catch (err) {
    return handleError(res, err);
  }
};

// PATCH /api/annotations/photos/:photoId/approve — aprueba TODAS las cajitas de la foto
// de una sola vez y dispara la sincronización con Custom Vision.
// Body opcional: { clienteAjustoCajitas?: boolean }, default true.
//
// FIX 2026-07-26: antes un solo UPDATE en annotationRepo.approvePhoto() marcaba
// is_validated=1 Y photo_approved=1 en la misma tabla. Con la migración de esquema, el
// estado de aprobación (con reviewer+fecha) vive en RETSC_AI_TRAINING_PHOTOS y la
// validación de cajitas sigue en RETSC_AI_TRAINING_ANNOTATIONS — son dos updates ahora.
// Se chequea primero que la FOTO exista (trainingPhotoRepo.approvePhoto devuelve null si
// no) antes de validar las anotaciones, en vez de inferir "no encontrada" de que no haya
// anotaciones — una foto recién subida sin cajitas todavía es un estado válido (ver
// shelfPhotoUploadService.js), no un 404.
//
// NOTA: hasta ahora el único disparador de annotationSyncService.syncApprovedPhoto() era
// el Issue #54 (externo, todavía no integrado en este repo) — esta ruta es un SEGUNDO
// disparador. Si #54 se integra más adelante, hay que decidir cuál de los dos llama a
// syncApprovedPhoto para no sincronizar la misma foto dos veces. No es urgente resolverlo
// ahora: syncRegionsForPhoto ya es idempotente por cv_region_id (ver splitByCvRegionId en
// annotationSyncService.js), así que una doble llamada no duplica regiones en Custom
// Vision, pero sí sería trabajo/llamadas HTTP redundantes.
//
// reviewerId sale SIEMPRE de req.user.userId, nunca del body — evita que alguien apruebe
// "en nombre de" otro usuario.
const approvePhoto = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const clienteAjustoCajitas = req.body?.clienteAjustoCajitas !== false;

    const photo = await trainingPhotoRepo.approvePhoto(photoId, req.user.userId);
    if (!photo) {
      return res.status(404).json({ success: false, message: `Foto ${photoId} no encontrada.` });
    }
    const annotations = await annotationRepo.validateAllByPhoto(photoId);

    // syncApprovedPhoto nunca lanza por fallos de Custom Vision (por diseño, ver su propio
    // header) — la aprobación ya quedó persistida en SQL en la línea de arriba y no se
    // revierte por un problema de sincronización. El resultado se devuelve igual para que
    // el frontend pueda avisar "aprobada, pero la sincronización con Custom Vision falló".
    const sync = await annotationSyncService.syncApprovedPhoto(photoId, { clienteAjustoCajitas });

    return res.json({ success: true, annotations, sync });
  } catch (err) {
    return handleError(res, err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Modo ANNOTATE / REVIEW de la guía de María v1.4 (secciones 2 y 3)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/annotations/photos/:photoId/image — devuelve los BYTES de la foto.
//
// Es un proxy, no una URL firmada (SAS), y es deliberado: el container es privado
// y un SAS vencería a los 60 minutos, obligando a detectar la expiración y a
// exponer otro endpoint sólo para refrescarlo — justo en medio de una sesión de
// anotación. Proxiando, la imagen queda protegida por el authMiddleware que ya
// existe, no vence nunca, y el container no se expone al navegador.
//
// El costo es que el tráfico de imágenes pasa por el API; para una herramienta
// interna de anotación es irrelevante.
const getPhotoImage = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');

    const photo = await trainingPhotoRepo.findById(photoId);
    if (!photo || !photo.blob_path) {
      return res.status(404).json({ success: false, message: `Foto ${photoId} no encontrada.` });
    }

    const buffer = await blobStorageService.downloadFromContainer({
      containerName: SHELF_CONTAINER(),
      blobPath: photo.blob_path,
    });

    const ext = path.extname(photo.blob_path).toLowerCase();
    res.set('Content-Type', CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream');
    // `private` porque la imagen va detrás de autenticación: no debe quedar en
    // caches compartidas. El blob es inmutable una vez subido, así que una hora
    // en la caché del navegador evita rebajarla en cada foto que se abre.
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(buffer);
  } catch (err) {
    // Blob borrado o path desfasado respecto de la fila: es 404, no un fallo del
    // servidor. Se distingue para no disparar alertas de 500 por fotos que ya no
    // están en el storage.
    const notFound = err.statusCode === 404
      || err.code === 'ENOENT'
      || err.details?.errorCode === 'BlobNotFound';
    if (notFound) {
      return res.status(404).json({ success: false, message: 'La imagen de la foto no está en el almacenamiento.' });
    }
    console.error('[annotation] error bajando la imagen:', err.message);
    return res.status(502).json({ success: false, message: 'No se pudo obtener la imagen del almacenamiento.' });
  }
};

// POST /api/annotations/photos/:photoId/regions — crear una cajita (sección 2.3).
//
// Es la contraparte del DELETE /:id que ya existía: se podían borrar y corregir
// cajitas, pero no crear ninguna desde la API.
//
// Del cuerpo sólo se toman las 4 coordenadas; la foto ya sabe su categoría, canal
// y blob_path, y esos datos no se duplican en la cajita.
const createRegion = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const { bbox_left, bbox_top, bbox_width, bbox_height } = req.body ?? {};

    // Mismo validador que usa `correct`: rango [0,1] y que la cajita no se salga
    // del marco. Se valida en el servidor porque el cliente no es la última línea
    // de defensa.
    annotationService.validateBbox({ bbox_left, bbox_top, bbox_width, bbox_height });

    const photo = await trainingPhotoRepo.findById(photoId);
    if (!photo) {
      return res.status(404).json({ success: false, message: `Foto ${photoId} no encontrada.` });
    }

    const created = await annotationRepo.insert({
      photo_id:     photoId,
      source:       'MANUAL',   // dibujada por una persona, no por el modelo
      is_validated: 1,          // guía 2.3
      bbox_left, bbox_top, bbox_width, bbox_height,
    });

    // Se devuelve la fila completa: el frontend necesita el annotation_id nuevo
    // para poder mover o borrar la cajita recién dibujada sin recargar el detalle.
    return res.status(201).json({ success: true, annotation: created });
  } catch (err) {
    return handleError(res, err);
  }
};

// PATCH /api/annotations/photos/:photoId/complete — "Completado" (sección 2.4).
const completePhoto = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');

    const photo = await trainingPhotoRepo.getPhotoWithRegions(photoId);
    if (!photo) {
      return res.status(404).json({ success: false, message: `Foto ${photoId} no encontrada.` });
    }
    // Mandar a revisión una foto sin cajitas le hace perder el tiempo al revisor.
    if (!(photo.regions ?? []).some(r => r.bbox_left != null)) {
      return res.status(409).json({
        success: false,
        message: 'La foto no tiene ninguna cajita dibujada: no se puede marcar como completada.',
      });
    }

    const updated = await trainingPhotoRepo.markComplete(photoId);
    return res.json({ success: true, photo: updated });
  } catch (err) {
    return handleError(res, err);
  }
};

// PATCH /api/annotations/photos/:photoId/reject — RECHAZAR con motivo (3.2).
// El motivo es obligatorio: la guía (3.3) exige que quien retome la foto sepa qué
// corregir. reviewerId sale SIEMPRE de req.user, nunca del body.
const rejectPhotoCtrl = async (req, res) => {
  try {
    const photoId = parseId(req.params.photoId, 'Photo ID');
    const motivo  = (req.body?.motivo ?? '').trim();

    if (!motivo) {
      return res.status(400).json({ success: false, message: 'El motivo del rechazo es obligatorio.' });
    }

    const updated = await trainingPhotoRepo.reject(photoId, req.user?.userId, motivo);
    if (!updated) {
      return res.status(404).json({ success: false, message: `Foto ${photoId} no encontrada.` });
    }
    return res.json({ success: true, photo: updated });
  } catch (err) {
    return handleError(res, err);
  }
};


// PATCH /api/annotations/photos/approve-batch — aprobar VARIAS fotos de una vez.
//
// Body: { photoIds: number[], clienteAjustoCajitas?: boolean }
//
// El motivo es de COSTOS, no de comodidad. Entrenar en Custom Vision cuesta lo
// mismo con 10 fotos que con 40: el gasto depende de cuántas VECES se entrena, no
// de cuántas cajitas se envían. Aprobando de a una, cada aprobación evalúa el
// umbral por su cuenta y puede disparar su propio entrenamiento. Acá el umbral se
// evalúa UNA sola vez al final, y una sola vez por categoría aunque el lote
// mezcle varias.
//
// Cada foto se procesa por separado y un fallo no aborta el resto: se devuelve el
// detalle por foto para que la UI diga exactamente cuáles quedaron pendientes.
const approvePhotosBatch = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.photoIds) ? req.body.photoIds : null;
    if (!ids || !ids.length) {
      return res.status(400).json({ success: false, message: 'photoIds es requerido y debe ser una lista con al menos un id.' });
    }
    if (ids.length > MAX_BATCH_APPROVE) {
      return res.status(400).json({
        success: false,
        message: `No se pueden aprobar más de ${MAX_BATCH_APPROVE} fotos por lote.`,
      });
    }

    const clienteAjustoCajitas = req.body?.clienteAjustoCajitas !== false;
    const aprobadas = [];
    const fallidas  = [];
    const categorias = new Set();

    for (const raw of ids) {
      const photoId = parseInt(raw, 10);
      try {
        if (isNaN(photoId)) throw Object.assign(new Error('id inválido'), { statusCode: 400 });

        const photo = await trainingPhotoRepo.getPhotoWithRegions(photoId);
        if (!photo) throw Object.assign(new Error('no encontrada'), { statusCode: 404 });
        if (!(photo.regions ?? []).some(r => r.bbox_left != null)) {
          throw Object.assign(new Error('no tiene ninguna cajita'), { statusCode: 409 });
        }

        await trainingPhotoRepo.approvePhoto(photoId, req.user.userId);
        await annotationRepo.validateAllByPhoto(photoId);

        // skipThresholdCheck: la verificación va una sola vez, al final del lote.
        await annotationSyncService.syncApprovedPhoto(photoId, {
          clienteAjustoCajitas,
          skipThresholdCheck: true,
        });

        categorias.add(photo.category_id);
        aprobadas.push(photoId);
      } catch (err) {
        console.warn(`[annotation] lote: foto ${photoId} falló — ${err.message}`);
        fallidas.push({ photoId, message: err.message });
      }
    }

    // UNA verificación de umbral por categoría, no una por foto.
    for (const categoryId of categorias) {
      await annotationSyncService.checkAndUpdateThreshold(categoryId)
        .catch(err => console.error(`[annotation] verificación de umbral falló (categoria=${categoryId}):`, err.message));
    }

    return res.json({
      success: true,
      aprobadas,
      fallidas,
      verificacionesDeUmbral: categorias.size,
    });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = {
  approve, correct, reject, listByPhoto, readiness, listPhotos, getPhotoDetail, approvePhoto,
  getPhotoImage, createRegion, completePhoto, rejectPhotoCtrl, approvePhotosBatch,
};
