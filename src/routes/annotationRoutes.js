// Rutas de revisión de anotaciones (Issue 7.5).
// Prefijo en app.js: /api/annotations  (montado con authMiddleware)
//
// Acciones de validación restringidas por rol. Roles permitidos configurables por
// env ANNOTATION_VALIDATOR_ROLES (CSV); default: 'ADMIN,ADMIN_DTC'.
// (El rol 'Supervisor' que este default usaba antes fue eliminado del catálogo
// — ver scripts/remove-legacy-roles.js. requireRole normaliza mayúsculas.)
// Listar y consultar readiness solo requieren estar autenticado.

const express      = require('express');
const router       = express.Router();
const requireRole  = require('../middlewares/requireRole');
const c            = require('../controllers/annotationController');

// Roles autorizados para aprobar/corregir/rechazar.
const VALIDATOR_ROLES = (process.env.ANNOTATION_VALIDATOR_ROLES || 'ADMIN,ADMIN_DTC')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const canValidate = requireRole(...VALIDATOR_ROLES);

/**
 * @swagger
 * components:
 *   schemas:
 *     Annotation:
 *       type: object
 *       properties:
 *         annotation_id: { type: integer, example: 101 }
 *         photo_id: { type: integer, example: 1 }
 *         bbox_left: { type: number, format: float, example: 0.12 }
 *         bbox_top: { type: number, format: float, example: 0.34 }
 *         bbox_width: { type: number, format: float, example: 0.2 }
 *         bbox_height: { type: number, format: float, example: 0.15 }
 *         source: { type: string, example: MANUAL, description: 'MANUAL (dibujada a mano) o el origen del modelo que la generó.' }
 *         is_validated: { type: integer, enum: [0, 1] }
 *         cv_region_id: { type: string, nullable: true, description: 'ID de la región en Custom Vision una vez sincronizada.' }
 *         created_at: { type: string, format: date-time }
 *     AnnotationPhoto:
 *       type: object
 *       properties:
 *         photo_id: { type: integer, example: 1 }
 *         blob_path: { type: string, example: 'shelf/2026/08/abc123.jpg' }
 *         canal: { type: string, enum: [OMT, DTT, CONVENIENCE] }
 *         dtc_category_id: { type: integer, example: 5 }
 *         photo_status:
 *           type: string
 *           enum: [EN_PROGRESO, LISTA_PARA_REVISION, APROBADA, RECHAZADA]
 *         regions:
 *           type: array
 *           items: { $ref: '#/components/schemas/Annotation' }
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean, example: false }
 *         message: { type: string }
 */

// Lectura (cualquier usuario autenticado) — primero las rutas /photo para evitar
// que ':id' capture 'photo'.

/**
 * @swagger
 * /api/annotations/photo/{photoId}:
 *   get:
 *     summary: Lista las anotaciones (cajitas) de una foto de góndola
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Abierta a cualquier usuario autenticado (a diferencia de las rutas /photos
 *       de más abajo, que están gateadas por rol de validador) — es una consulta de
 *       solo lectura, no la cola de trabajo del revisor.
 *     parameters:
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *         description: ID de la foto (RETSC_AI_TRAINING_PHOTOS.photo_id).
 *     responses:
 *       200:
 *         description: Lista de anotaciones de la foto
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 annotations:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Annotation' }
 *       400:
 *         description: photoId inválido (no numérico)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 */
router.get('/photo/:photoId',            c.listByPhoto);
/**
 * @swagger
 * /api/annotations/photo/{photoId}/readiness:
 *   get:
 *     summary: Indica si una foto está lista para entrenar (al menos 1 anotación validada)
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Abierta a cualquier usuario autenticado, igual que GET /photo/{photoId}.
 *       "ready" significa que hay al menos una anotación con is_validated=1 — no
 *       implica que la FOTO ya esté aprobada (eso es photo_status='APROBADA').
 *     parameters:
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *         description: ID de la foto.
 *     responses:
 *       200:
 *         description: Estado de completitud de la foto
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 photoId: { type: integer, example: 1 }
 *                 total: { type: integer, description: 'Total de anotaciones de la foto.' }
 *                 validated: { type: integer, description: 'Cuántas de esas están validadas (is_validated=1).' }
 *                 ready: { type: boolean, description: 'true si validated >= 1.' }
 *       400:
 *         description: photoId inválido
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 */
router.get('/photo/:photoId/readiness',  c.readiness);

// Review queue (Issue 8.2 + menú por rol 2026-07-25) — "Anotaciones" (ADMIN_DTC) y
// "Revisar cajitas" (ADMIN). A diferencia de /photo/:photoId de arriba (abierta a
// cualquier autenticado), esta va gateada por canValidate: es la cola de trabajo del
// revisor, no una consulta de solo-lectura general.
// '/photos' (plural) no colisiona con '/photo/:photoId' (singular, distinto segmento
// literal) ni con las rutas ':id' de más abajo (distinta cantidad de segmentos) —
// verificado levantando el router, no solo por inspección.
// Aprobación EN LOTE. Va ANTES de '/photos/:photoId...' a propósito: aunque hoy
// ninguna ruta PATCH de un solo segmento bajo /photos colisiona, registrar la
// literal primero evita que un ':photoId' futuro se la coma silenciosamente.
/**
 * @swagger
 * /api/annotations/photos/approve-batch:
 *   patch:
 *     summary: Aprueba VARIAS fotos de una sola vez (cola de revisión en lote)
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Cada foto se procesa por separado y un fallo no aborta el resto — se
 *       devuelve el detalle de qué fotos fallaron y por qué. La verificación del
 *       umbral de entrenamiento se hace UNA sola vez por categoría al final del
 *       lote (no una vez por foto), para no disparar entrenamientos redundantes
 *       en Custom Vision. Tope de 50 fotos por lote (MAX_BATCH_APPROVE) — evita
 *       que la petición HTTP quede abierta minutos y se lleve un timeout de proxy
 *       con parte del trabajo ya hecho.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [photoIds]
 *             properties:
 *               photoIds:
 *                 type: array
 *                 items: { type: integer }
 *                 example: [10, 11, 12]
 *                 description: Máximo 50 elementos.
 *               clienteAjustoCajitas:
 *                 type: boolean
 *                 default: true
 *                 description: >-
 *                   Se aplica a cada foto del lote. false solo se honra si esa
 *                   foto ya tiene alguna cajita sincronizada con Custom Vision
 *                   antes; si nunca se sincronizó, el flag se ignora y se
 *                   sincroniza igual.
 *     responses:
 *       200:
 *         description: Resultado del lote (puede incluir fotos fallidas sin que la petición falle)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 aprobadas:
 *                   type: array
 *                   items: { type: integer }
 *                   description: IDs de las fotos aprobadas y sincronizadas correctamente.
 *                 fallidas:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       photoId: { type: integer }
 *                       message: { type: string }
 *                   description: Fotos que no se pudieron aprobar (no encontrada, sin cajitas, id inválido, etc).
 *                 verificacionesDeUmbral:
 *                   type: integer
 *                   description: Cantidad de categorías distintas para las que se evaluó el umbral de re-entrenamiento.
 *       400:
 *         description: photoIds faltante/vacío, o con más de 50 elementos
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador (ANNOTATION_VALIDATOR_ROLES)
 */
router.patch('/photos/approve-batch',        canValidate, c.approvePhotosBatch);

/**
 * @swagger
 * /api/annotations/photos:
 *   get:
 *     summary: Cola de revisión de fotos (review queue)
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Alimenta las pantallas "Anotaciones" (ADMIN_DTC) y "Revisar cajitas"
 *       (ADMIN) del menú. A diferencia de GET /photo/{photoId} (abierta a
 *       cualquier autenticado), esta va gateada por rol de validador: es la cola
 *       de trabajo del revisor, no una consulta general.
 *     parameters:
 *       - in: query
 *         name: categoryId
 *         schema: { type: integer }
 *         description: Filtra por categoría DTC.
 *       - in: query
 *         name: canal
 *         schema: { type: string, enum: [OMT, DTT, CONVENIENCE] }
 *         description: Filtra por canal. Un valor fuera de este enum devuelve 400.
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [EN_PROGRESO, LISTA_PARA_REVISION, APROBADA, RECHAZADA] }
 *         description: Filtra por photo_status.
 *     responses:
 *       200:
 *         description: Lista de fotos (una fila por foto, con el conteo de sus cajitas)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 photos:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/AnnotationPhoto' }
 *       400:
 *         description: canal fuera del enum válido, o categoryId no numérico
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 */
router.get('/photos',                        canValidate, c.listPhotos);

/**
 * @swagger
 * /api/annotations/photos/{photoId}:
 *   get:
 *     summary: Detalle de una foto con todas sus cajitas
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Foto con su lista de anotaciones (regions)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 photo: { $ref: '#/components/schemas/AnnotationPhoto' }
 *       400:
 *         description: photoId inválido
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 *       404:
 *         description: Foto no encontrada
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get('/photos/:photoId',               canValidate, c.getPhotoDetail);

/**
 * @swagger
 * /api/annotations/photos/{photoId}/approve:
 *   patch:
 *     summary: Aprueba TODAS las cajitas de una foto y dispara la sincronización con Custom Vision
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Marca la foto como APROBADA (reviewer + fecha se toman de req.user, nunca
 *       del body) y valida todas sus anotaciones de una sola vez. La sincronización
 *       con Custom Vision nunca hace fallar esta petición: si falla, la aprobación
 *       ya quedó persistida en SQL y se devuelve igual el resultado del intento de
 *       sync en el campo "sync", para que el frontend pueda avisar que la
 *       aprobación se hizo pero la sincronización falló.
 *     parameters:
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               clienteAjustoCajitas:
 *                 type: boolean
 *                 default: true
 *                 description: >-
 *                   Solo se honra en false si ya hay alguna cajita sincronizada
 *                   previamente con Custom Vision; si esta es la primera
 *                   sincronización de la foto, el flag se ignora y se sincroniza
 *                   igual.
 *     responses:
 *       200:
 *         description: Foto aprobada, cajitas validadas y resultado de la sincronización
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 annotations:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Annotation' }
 *                 sync:
 *                   type: object
 *                   properties:
 *                     synced: { type: boolean }
 *                     reason: { type: string, description: 'PHOTO_NOT_FOUND o NO_ANNOTATIONS si synced=false.' }
 *                     categoryId: { type: integer }
 *       400:
 *         description: photoId inválido
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 *       404:
 *         description: Foto no encontrada
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.patch('/photos/:photoId/approve',     canValidate, c.approvePhoto);

// Modo ANNOTATE / REVIEW de la guía de María v1.4.
// Bytes de la foto (proxy del blob privado) — ver getPhotoImage para por qué es
// un proxy y no una URL firmada.
/**
 * @swagger
 * /api/annotations/photos/{photoId}/image:
 *   get:
 *     summary: Devuelve los bytes de la imagen de una foto (proxy del blob privado)
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Es un proxy, no una URL firmada (SAS) — el container de Azure Blob es
 *       privado y así la imagen queda protegida por el mismo authMiddleware, sin
 *       vencimiento y sin exponer el container al navegador. Devuelve el binario
 *       directo con el Content-Type derivado de la extensión del blob, no un JSON.
 *     parameters:
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Bytes de la imagen
 *         content:
 *           image/jpeg: { schema: { type: string, format: binary } }
 *           image/png: { schema: { type: string, format: binary } }
 *       400:
 *         description: photoId inválido
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 *       404:
 *         description: Foto no encontrada, o el blob ya no está en el almacenamiento
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       502:
 *         description: Error al descargar el blob desde Azure Storage
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get('/photos/:photoId/image',         canValidate, c.getPhotoImage);

/**
 * @swagger
 * /api/annotations/photos/{photoId}/regions:
 *   post:
 *     summary: Crea una cajita (anotación manual) sobre una foto
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Contraparte de DELETE /{id}: antes se podían borrar y corregir cajitas
 *       pero no crear ninguna desde la API. Se crea con source=MANUAL e
 *       is_validated=1 directamente. Las coordenadas van normalizadas en [0,1] y
 *       se validan en el servidor (rango y que la cajita no se salga del marco).
 *     parameters:
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bbox_left, bbox_top, bbox_width, bbox_height]
 *             properties:
 *               bbox_left: { type: number, format: float, example: 0.1 }
 *               bbox_top: { type: number, format: float, example: 0.2 }
 *               bbox_width: { type: number, format: float, example: 0.15 }
 *               bbox_height: { type: number, format: float, example: 0.1 }
 *     responses:
 *       201:
 *         description: Cajita creada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 annotation: { $ref: '#/components/schemas/Annotation' }
 *       400:
 *         description: photoId inválido, o coordenadas fuera de rango [0,1] / que se salen del marco
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 *       404:
 *         description: Foto no encontrada
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.post('/photos/:photoId/regions',      canValidate, c.createRegion);

/**
 * @swagger
 * /api/annotations/photos/{photoId}/complete:
 *   patch:
 *     summary: Marca una foto como "completada" por quien la anotó (no la aprueba)
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Modo ANNOTATE de la guía de María v1.4 (sección 2.4). Solo declara que la
 *       persona que anota terminó su trabajo; la aprobación es un paso aparte
 *       (PATCH /photos/{photoId}/approve). Falla con 409 si la foto no tiene
 *       ninguna cajita dibujada todavía.
 *     parameters:
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Foto marcada como completada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 photo: { $ref: '#/components/schemas/AnnotationPhoto' }
 *       400:
 *         description: photoId inválido
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 *       404:
 *         description: Foto no encontrada
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       409:
 *         description: La foto no tiene ninguna cajita dibujada
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.patch('/photos/:photoId/complete',    canValidate, c.completePhoto);

/**
 * @swagger
 * /api/annotations/photos/{photoId}/reject:
 *   patch:
 *     summary: Rechaza una foto completa con motivo obligatorio
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Modo REVIEW de la guía de María v1.4 (sección 3.2). El motivo se agrega a
 *       photo_notes para que quien retome la foto sepa qué corregir (sección
 *       3.3). El reviewerId sale siempre de req.user, nunca del body.
 *     parameters:
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [motivo]
 *             properties:
 *               motivo:
 *                 type: string
 *                 example: 'Cajitas mal recortadas en la góndola superior.'
 *     responses:
 *       200:
 *         description: Foto rechazada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 photo: { $ref: '#/components/schemas/AnnotationPhoto' }
 *       400:
 *         description: Falta el motivo (vacío o solo espacios), o photoId inválido
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 *       404:
 *         description: Foto no encontrada
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.patch('/photos/:photoId/reject',      canValidate, c.rejectPhotoCtrl);

// Acciones de validación (solo roles autorizados)

/**
 * @swagger
 * /api/annotations/{id}/approve:
 *   patch:
 *     summary: Aprueba (valida) una anotación individual
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: annotation_id.
 *     responses:
 *       200:
 *         description: Anotación marcada como validada (is_validated=1)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 annotation: { $ref: '#/components/schemas/Annotation' }
 *       400:
 *         description: id inválido
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 *       404:
 *         description: Anotación no encontrada
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.patch('/:id/approve', canValidate, c.approve);  // APROBAR

/**
 * @swagger
 * /api/annotations/{id}:
 *   patch:
 *     summary: Corrige las coordenadas de una anotación y la marca como validada
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Mismo validador de bbox que POST /photos/{photoId}/regions: coordenadas
 *       normalizadas en [0,1] y la cajita no puede salirse del marco.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: annotation_id.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bbox_left, bbox_top, bbox_width, bbox_height]
 *             properties:
 *               bbox_left: { type: number, format: float, example: 0.1 }
 *               bbox_top: { type: number, format: float, example: 0.2 }
 *               bbox_width: { type: number, format: float, example: 0.15 }
 *               bbox_height: { type: number, format: float, example: 0.1 }
 *     responses:
 *       200:
 *         description: Anotación corregida y validada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 annotation: { $ref: '#/components/schemas/Annotation' }
 *       400:
 *         description: id inválido, o coordenadas fuera de rango / que se salen del marco
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 *       404:
 *         description: Anotación no encontrada
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.patch('/:id',         canValidate, c.correct);  // CORREGIR

/**
 * @swagger
 * /api/annotations/{id}:
 *   delete:
 *     summary: Rechaza (elimina) una anotación
 *     tags: [Annotations]
 *     security:
 *       - bearerAuth: []
 *     description: >-
 *       Eliminación física (hard delete), no un soft-delete. Bloqueada con 409 si
 *       es la última anotación restante de su foto — una foto debe conservar al
 *       menos una para no quedar sin nada que entrenar; para descartar la foto
 *       completa existe el flujo de PATCH /photos/{photoId}/reject.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: annotation_id.
 *     responses:
 *       200:
 *         description: Anotación eliminada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 deleted: { type: boolean, example: true }
 *                 annotationId: { type: integer }
 *                 photoId: { type: integer }
 *       400:
 *         description: id inválido
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Sin token, o token expirado
 *       403:
 *         description: Autenticado pero sin rol de validador
 *       404:
 *         description: Anotación no encontrada
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       409:
 *         description: Es la última anotación de la foto — no se puede rechazar
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.delete('/:id',        canValidate, c.reject);   // RECHAZAR

module.exports = router;
