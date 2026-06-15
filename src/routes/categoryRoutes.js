const express      = require("express");
const router       = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const requireAdmin   = require("../middlewares/requireAdmin");
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

// ────────────── Lectura ──────────────
router.get("/",              listGlobal);   // GET  /api/categories
router.get("/roots",         getRoots);     // GET  /api/categories/roots
router.get("/:id/children",  getChildren);  // GET  /api/categories/:id/children
router.get("/:id",           getById);      // GET  /api/categories/:id

// ────────────── Escritura (superadmin DTC — rol se agrega en iteración futura) ──────────────
router.post("/",    createCategory);    // POST   /api/categories
router.put("/:id",  updateCategory);    // PUT    /api/categories/:id
router.delete("/:id", deactivateCategory); // DELETE /api/categories/:id

// ────────────── Infraestructura IA (solo Admin) ──────────────
// Reintenta el provisioning de Blob + Custom Vision para una categoría smart DTC
// que quedó en estado PENDING por fallo temporal de Azure.
router.post("/:id/retry-ai-infra", authMiddleware, requireAdmin, retryAiInfra);

module.exports = router;
