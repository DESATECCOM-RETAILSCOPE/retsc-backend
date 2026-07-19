const express      = require("express");
const router       = express.Router();
const requireRole    = require("../middlewares/requireRole");
const { ROLES }       = require("../config/roles");
const {
  listGlobal,
  getRoots,
  getChildren,
  getById,
  createCategory,
  updateCategory,
  deactivateCategory,
  retryAiInfra,
} = require("../controllers/categoryController");

// authMiddleware ya se aplica globalmente sobre todo /api/categories en app.js.

// ────────────── Lectura — cualquier usuario autenticado de la empresa ──────────
// Alimentan los dropdowns de Carga de SKUs, Fotos de Góndola, Productos, etc. —
// NO restringir a ADMIN_DTC (Issue B4, feedback dueña: solo la GESTIÓN del
// árbol DTC es exclusiva de ADMIN_DTC, la lectura sigue siendo de cualquiera).
router.get("/",              listGlobal);   // GET  /api/categories
router.get("/roots",         getRoots);     // GET  /api/categories/roots
router.get("/:id/children",  getChildren);  // GET  /api/categories/:id/children
router.get("/:id",           getById);      // GET  /api/categories/:id

// ────────────── Escritura (Taxonomía DTC — exclusivo ADMIN_DTC) ────────────────
// Abrir/editar una categoría acá crea los contenedores vacíos en
// GLOBAL_TRAINING_SKU / GLOBAL_SHELF_TRAINING y arma los modelos de
// entrenamiento — antes no tenía NINGÚN rol asignado (cualquier usuario
// autenticado podía disparar esto), solo un comentario "rol se agrega en
// iteración futura" que nunca se completó.
const dtcOnly = requireRole(ROLES.ADMIN_DTC);
router.post("/",    dtcOnly, createCategory);    // POST   /api/categories
router.put("/:id",  dtcOnly, updateCategory);    // PUT    /api/categories/:id
router.delete("/:id", dtcOnly, deactivateCategory); // DELETE /api/categories/:id

// ────────────── Infraestructura IA (exclusivo ADMIN_DTC) ───────────────────────
// Reintenta el provisioning de Blob + Custom Vision para una categoría smart DTC
// que quedó en estado PENDING por fallo temporal de Azure. Solo toca el
// middleware de la ruta — la lógica de aiInfrastructureService no se modifica
// (es de Joel).
router.post("/:id/retry-ai-infra", dtcOnly, retryAiInfra);

module.exports = router;
