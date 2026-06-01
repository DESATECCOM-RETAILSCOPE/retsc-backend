const express = require("express");
const router = express.Router();
const {
  listGlobal,
  getRoots,
  getChildren,
  getById,
  createCategory,
  updateCategory,
  deactivateCategory,
} = require("../controllers/categoryController");

// ────────────── Lectura ──────────────
router.get("/", listGlobal); // GET  /api/categories
router.get("/roots", getRoots); // GET  /api/categories/roots
router.get("/:id/children", getChildren); // GET  /api/categories/:id/children
router.get("/:id", getById); // GET  /api/categories/:id

// ────────────── Escritura (superadmin DTC — rol se agrega en iteración futura) ──────────────
router.post("/", createCategory); // POST /api/categories
router.put("/:id", updateCategory); // PUT  /api/categories/:id
router.delete("/:id", deactivateCategory); // DELETE /api/categories/:id

module.exports = router;
