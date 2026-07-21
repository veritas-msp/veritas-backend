import express from "express";
import { body, param, validationResult } from "express-validator";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { createContractModuleOption, deleteContractModuleOption, listContractModuleOptions, resetContractModuleOptions, updateContractModuleOption } from "../../utils/contractModuleOptions.js";
const router = express.Router();
router.use(verifyJWT);
function handleError(res, err, context) {
  console.error(context, err);
  res.status(err.status || 500).json({
    error: err.message || "Server error."
  });
}
router.get("/", async (req, res) => {
  try {
    const includeDisabled = req.query.includeDisabled === "1" || req.query.includeDisabled === "true";
    const modules = await listContractModuleOptions({
      includeDisabled
    });
    res.json({
      modules
    });
  } catch (err) {
    handleError(res, err, "GET /contract-module-options");
  }
});
router.get("/admin", verifyJWT, requireRole("admin"), async (_req, res) => {
  try {
    const modules = await listContractModuleOptions({
      includeDisabled: true,
      includeUsage: true
    });
    res.json({
      modules
    });
  } catch (err) {
    handleError(res, err, "GET /contract-module-options/admin");
  }
});
router.post("/", verifyJWT, requireRole("admin"), [body("label").isString().trim().notEmpty(), body("moduleKey").optional().isString().trim(), body("icon").optional().isString().trim(), body("enabled").optional().isBoolean(), body("sortOrder").optional().isInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "Invalid request",
      details: errors.array()
    });
  }
  try {
    const module = await createContractModuleOption(req.body);
    res.status(201).json({
      module
    });
  } catch (err) {
    handleError(res, err, "POST /contract-module-options");
  }
});
router.post("/reset", verifyJWT, requireRole("admin"), async (_req, res) => {
  try {
    const modules = await resetContractModuleOptions();
    res.json({
      modules
    });
  } catch (err) {
    handleError(res, err, "POST /contract-module-options/reset");
  }
});
router.patch("/:id", verifyJWT, requireRole("admin"), [param("id").isInt({
  min: 1
}), body("label").optional().isString().trim().notEmpty(), body("icon").optional().isString().trim(), body("enabled").optional().isBoolean(), body("sortOrder").optional().isInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "Invalid request",
      details: errors.array()
    });
  }
  try {
    const module = await updateContractModuleOption(req.params.id, req.body);
    res.json({
      module
    });
  } catch (err) {
    handleError(res, err, "PATCH /contract-module-options/:id");
  }
});
router.delete("/:id", verifyJWT, requireRole("admin"), [param("id").isInt({
  min: 1
})], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "Invalid request",
      details: errors.array()
    });
  }
  try {
    await deleteContractModuleOption(req.params.id);
    res.json({
      success: true
    });
  } catch (err) {
    handleError(res, err, "DELETE /contract-module-options/:id");
  }
});
export default router;
