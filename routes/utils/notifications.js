import express from "express";
import { body, param, query, validationResult } from "express-validator";
import verifyJWT from "../../middleware/auth.js";
import {
  createTestUserNotification,
  getUnreadNotificationCount,
  getUserInAppPreferencesPayload,
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  archiveNotification,
  archiveAllNotifications,
  saveUserInAppPreferences,
} from "../../services/userNotificationService.js";

const router = express.Router();

function validationErrorOrNull(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json({
    error: "Erreur de validation",
    errors: errors.array(),
  });
}

router.use(verifyJWT);

router.get("/preferences", async (req, res) => {
  try {
    const payload = await getUserInAppPreferencesPayload(req.user.id);
    res.json(payload);
  } catch (err) {
    console.error("GET /notifications/preferences:", err);
    res.status(500).json({ error: "Erreur lors de la récupération des préférences" });
  }
});

router.put(
  "/preferences",
  [body("userPreferences").isObject()],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    try {
      const saved = await saveUserInAppPreferences(req.user.id, req.body.userPreferences);
      const payload = await getUserInAppPreferencesPayload(req.user.id);
      res.json({
        success: true,
        userPreferences: saved,
        ...payload,
      });
    } catch (err) {
      console.error("PUT /notifications/preferences:", err);
      res.status(500).json({ error: "Erreur lors de la sauvegarde des préférences" });
    }
  }
);

router.get(
  "/",
  [
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("offset").optional().isInt({ min: 0 }),
    query("unreadOnly").optional().isBoolean(),
    query("archivedOnly").optional().isBoolean(),
    query("ticketId").optional().isUUID(),
  ],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    try {
      const unreadOnly =
        req.query.unreadOnly === "true" ||
        req.query.unreadOnly === true ||
        req.query.unreadOnly === "1";
      const archivedOnly =
        req.query.archivedOnly === "true" ||
        req.query.archivedOnly === true ||
        req.query.archivedOnly === "1";
      const payload = await listUserNotifications(req.user.id, {
        limit: Number(req.query.limit) || 30,
        offset: Number(req.query.offset) || 0,
        unreadOnly,
        archivedOnly,
        ticketId: req.query.ticketId ? String(req.query.ticketId) : null,
      });
      res.json(payload);
    } catch (err) {
      console.error("GET /notifications:", err);
      res.status(500).json({ error: "Erreur lors de la récupération des notifications" });
    }
  }
);

router.get("/unread-count", async (req, res) => {
  try {
    const count = await getUnreadNotificationCount(req.user.id);
    res.json({ count });
  } catch (err) {
    console.error("GET /notifications/unread-count:", err);
    res.status(500).json({ error: "Erreur lors du comptage des notifications" });
  }
});

router.patch(
  "/:id/read",
  [param("id").isUUID()],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    try {
      const updated = await markNotificationRead(req.user.id, req.params.id);
      if (!updated) {
        return res.status(404).json({ error: "Notification introuvable" });
      }
      res.json(updated);
    } catch (err) {
      console.error("PATCH /notifications/:id/read:", err);
      res.status(500).json({ error: "Erreur lors de la mise à jour de la notification" });
    }
  }
);

router.patch(
  "/:id/archive",
  [param("id").isUUID()],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    try {
      const updated = await archiveNotification(req.user.id, req.params.id);
      if (!updated) {
        return res.status(404).json({ error: "Notification introuvable" });
      }
      res.json(updated);
    } catch (err) {
      console.error("PATCH /notifications/:id/archive:", err);
      res.status(500).json({ error: "Erreur lors de l'archivage de la notification" });
    }
  }
);

router.post(
  "/test",
  [body("type").optional().isString(), body("locale").optional().isString()],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    try {
      const type = String(req.body?.type || "ticket_commented").trim();
      const locale = String(req.body?.locale || "fr").trim();
      const notification = await createTestUserNotification(req.user.id, type, locale);
      res.status(201).json({
        success: true,
        message: "Notification test créée.",
        notification,
      });
    } catch (err) {
      console.error("POST /notifications/test:", err);
      res.status(500).json({ error: "Impossible d'envoyer la notification test." });
    }
  }
);

router.post(
  "/read-all",
  [body("ticketId").optional().isUUID()],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    try {
      const count = await markAllNotificationsRead(req.user.id, {
        ticketId: req.body?.ticketId ? String(req.body.ticketId) : null,
      });
      res.json({ success: true, count });
    } catch (err) {
      console.error("POST /notifications/read-all:", err);
      res.status(500).json({ error: "Erreur lors du marquage des notifications" });
    }
  }
);

router.post(
  "/archive-all",
  [body("ticketId").optional().isUUID()],
  async (req, res) => {
    const validationResponse = validationErrorOrNull(req, res);
    if (validationResponse) return;

    try {
      const count = await archiveAllNotifications(req.user.id, {
        ticketId: req.body?.ticketId ? String(req.body.ticketId) : null,
      });
      res.json({ success: true, count });
    } catch (err) {
      console.error("POST /notifications/archive-all:", err);
      res.status(500).json({ error: "Erreur lors de l'archivage des notifications" });
    }
  }
);

export default router;
