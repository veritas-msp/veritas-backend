import express from "express";
import { body, param, query, validationResult } from "express-validator";
import verifyJWT from "../../middleware/auth.js";
import { createTestUserNotification, getUnreadNotificationCount, getUserInAppPreferencesPayload, listUserNotifications, markAllNotificationsRead, markNotificationRead, archiveNotification, archiveAllNotifications, saveUserInAppPreferences } from "../../services/userNotificationService.js";
const router = express.Router();
function validationErrorOrNull(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json({
    error: "Validation error",
    errors: errors.array()
  });
}
router.use(verifyJWT);
router.get("/preferences", async (req, res) => {
  try {
    const payload = await getUserInAppPreferencesPayload(req.user.id);
    res.json(payload);
  } catch (err) {
    console.error("GET /notifications/preferences:", err);
    res.status(500).json({
      error: "Error retrieving preferences"
    });
  }
});
router.put("/preferences", [body("userPreferences").isObject()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const saved = await saveUserInAppPreferences(req.user.id, req.body.userPreferences);
    const payload = await getUserInAppPreferencesPayload(req.user.id);
    res.json({
      success: true,
      userPreferences: saved,
      ...payload
    });
  } catch (err) {
    console.error("PUT /notifications/preferences:", err);
    res.status(500).json({
      error: "Error saving preferences"
    });
  }
});
router.get("/", [query("limit").optional().isInt({
  min: 1,
  max: 100
}), query("offset").optional().isInt({
  min: 0
}), query("unreadOnly").optional().isBoolean(), query("archivedOnly").optional().isBoolean(), query("ticketId").optional().isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const unreadOnly = req.query.unreadOnly === "true" || req.query.unreadOnly === true || req.query.unreadOnly === "1";
    const archivedOnly = req.query.archivedOnly === "true" || req.query.archivedOnly === true || req.query.archivedOnly === "1";
    const payload = await listUserNotifications(req.user.id, {
      limit: Number(req.query.limit) || 30,
      offset: Number(req.query.offset) || 0,
      unreadOnly,
      archivedOnly,
      ticketId: req.query.ticketId ? String(req.query.ticketId) : null
    });
    res.json(payload);
  } catch (err) {
    console.error("GET /notifications:", err);
    res.status(500).json({
      error: "Error retrieving notifications"
    });
  }
});
router.get("/unread-count", async (req, res) => {
  try {
    const count = await getUnreadNotificationCount(req.user.id);
    res.json({
      count
    });
  } catch (err) {
    console.error("GET /notifications/unread-count:", err);
    res.status(500).json({
      error: "Error during comptage notifications"
    });
  }
});
router.patch("/:id/read", [param("id").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const updated = await markNotificationRead(req.user.id, req.params.id);
    if (!updated) {
      return res.status(404).json({
        error: "Notification not found"
      });
    }
    res.json(updated);
  } catch (err) {
    console.error("PATCH /notifications/:id/read:", err);
    res.status(500).json({
      error: "Error updating notification"
    });
  }
});
router.patch("/:id/archive", [param("id").isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const updated = await archiveNotification(req.user.id, req.params.id);
    if (!updated) {
      return res.status(404).json({
        error: "Notification not found"
      });
    }
    res.json(updated);
  } catch (err) {
    console.error("PATCH /notifications/:id/archive:", err);
    res.status(500).json({
      error: "Error archiving notification"
    });
  }
});
router.post("/test", [body("type").optional().isString(), body("locale").optional().isString()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const type = String(req.body?.type || "ticket_commented").trim();
    const locale = String(req.body?.locale || "fr").trim();
    const notification = await createTestUserNotification(req.user.id, type, locale);
    res.status(201).json({
      success: true,
      message: "Tis notification created.",
      notification
    });
  } catch (err) {
    console.error("POST /notifications/test:", err);
    res.status(500).json({
      error: "Unabto send tis notification."
    });
  }
});
router.post("/read-all", [body("ticketId").optional().isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const count = await markAllNotificationsRead(req.user.id, {
      ticketId: req.body?.ticketId ? String(req.body.ticketId) : null
    });
    res.json({
      success: true,
      count
    });
  } catch (err) {
    console.error("POST /notifications/read-all:", err);
    res.status(500).json({
      error: "Error during marquage notifications"
    });
  }
});
router.post("/archive-all", [body("ticketId").optional().isUUID()], async (req, res) => {
  const validationResponse = validationErrorOrNull(req, res);
  if (validationResponse) return;
  try {
    const count = await archiveAllNotifications(req.user.id, {
      ticketId: req.body?.ticketId ? String(req.body.ticketId) : null
    });
    res.json({
      success: true,
      count
    });
  } catch (err) {
    console.error("POST /notifications/archive-all:", err);
    res.status(500).json({
      error: "Error archiving notifications"
    });
  }
});
export default router;
