import express from "express";
import { body, param, validationResult } from "express-validator";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import {
  createEquipmentFamily,
  deleteEquipmentFamily,
  listEquipmentFamilies,
  updateEquipmentFamily,
} from "../../utils/equipmentFamilies.js";

const router = express.Router();
router.use(verifyJWT);

function handleError(res, err, context) {
  console.error(context, err);
  res.status(err.status || 500).json({ error: err.message || "Erreur serveur." });
}

router.get("/", async (_req, res) => {
  try {
    const families = await listEquipmentFamilies({ includeDisabled: false });
    res.json({ families });
  } catch (err) {
    handleError(res, err, "GET /equipment-families");
  }
});

router.get("/admin", verifyJWT, requireRole("admin"), async (_req, res) => {
  try {
    const families = await listEquipmentFamilies({ includeDisabled: true, includeUsage: true });
    res.json({ families });
  } catch (err) {
    handleError(res, err, "GET /equipment-families/admin");
  }
});

router.post(
  "/",
  verifyJWT,
  requireRole("admin"),
  [
    body("label").isString().trim().notEmpty(),
    body("familyKey").optional().isString().trim(),
    body("icon").optional().isString().trim(),
    body("displayMode").optional().isIn(["hexagon", "brick"]),
    body("enabled").optional().isBoolean(),
    body("sortOrder").optional().isInt(),
    body("fields").optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Requête invalide", details: errors.array() });
    }
    try {
      const family = await createEquipmentFamily(req.body);
      res.status(201).json({ family });
    } catch (err) {
      handleError(res, err, "POST /equipment-families");
    }
  }
);

router.patch(
  "/:id",
  verifyJWT,
  requireRole("admin"),
  [
    param("id").isInt({ min: 1 }),
    body("label").optional().isString().trim().notEmpty(),
    body("familyKey").optional().isString().trim(),
    body("icon").optional().isString().trim(),
    body("displayMode").optional().isIn(["hexagon", "brick"]),
    body("enabled").optional().isBoolean(),
    body("sortOrder").optional().isInt(),
    body("fields").optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Requête invalide", details: errors.array() });
    }
    try {
      const family = await updateEquipmentFamily(Number(req.params.id), req.body);
      res.json({ family });
    } catch (err) {
      handleError(res, err, "PATCH /equipment-families/:id");
    }
  }
);

router.delete(
  "/:id",
  verifyJWT,
  requireRole("admin"),
  [param("id").isInt({ min: 1 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Requête invalide", details: errors.array() });
    }
    try {
      await deleteEquipmentFamily(Number(req.params.id));
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "DELETE /equipment-families/:id");
    }
  }
);

export default router;
