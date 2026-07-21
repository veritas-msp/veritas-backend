import express from "express";
import multer from "multer";
import { pool } from "../../database/db.js";
import verifyJWT from "../../middleware/auth.js";
import { sendMail } from "../../utils/sendMail.js";
import { getSettingsMap } from "../../utils/settingsHelper.js";
const router = express.Router();
const REQUEST_TYPES = new Set(["bug", "improvement", "question"]);
const TYPE_LABELS = {
  bug: "Bug / malfunction",
  improvement: "Improvement",
  question: "Question / help"
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 5
  },
  fileFilter: (_req, file, cb) => {
    if (String(file.mimetype || "").startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only images are accepted."));
  }
});
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function parseContext(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
router.post("/report", verifyJWT, (req, res, next) => {
  upload.array("images", 5)(req, res, err => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: "Each image must not exceed 5 MB."
        });
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({
          error: "A maximum of 5 images is allowed."
        });
      }
      return res.status(400).json({
        error: err.message || "Invalid file."
      });
    }
    next();
  });
}, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    const type = String(req.body?.type || "bug").trim().toLowerCase();
    if (!title || title.length < 3) {
      return res.status(400).json({
        error: "Title must contain at least 3 characters."
      });
    }
    if (!description || description.length < 10) {
      return res.status(400).json({
        error: "Description must contain at least 10 characters."
      });
    }
    if (!REQUEST_TYPES.has(type)) {
      return res.status(400).json({
        error: "Invalid request type."
      });
    }
    const settings = await getSettingsMap(["BUG_REPORT_EMAIL", "SUPPORT_EMAIL"]);
    const destination = settings.SUPPORT_EMAIL?.trim() || settings.BUG_REPORT_EMAIL?.trim() || process.env.BUG_REPORT_EMAIL?.trim();
    if (!destination) {
      return res.status(503).json({
        error: "No support address configured. Contact your administrator."
      });
    }
    const {
      rows
    } = await pool.query(`SELECT id, username, email, role, profile FROM v_b_users WHERE id = $1`, [req.user.id]);
    const user = rows[0] || {};
    const context = parseContext(req.body?.context);
    const reference = `VR-${Date.now().toString(36).toUpperCase()}`;
    const typeLabel = TYPE_LABELS[type] || type;
    const files = Array.isArray(req.files) ? req.files : [];
    const contextHtml = context ? `
        <h3 style="margin:20px 0 8px;font-size:14px;">Technical context</h3>
        <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6;">
          ${context.page ? `<li><strong>Page:</strong> ${escapeHtml(context.page)}</li>` : ""}
          ${context.userAgent ? `<li><strong>Browser:</strong> ${escapeHtml(context.userAgent)}</li>` : ""}
          ${context.screen ? `<li><strong>Screen:</strong> ${escapeHtml(context.screen)}</li>` : ""}
          ${context.appVersion ? `<li><strong>Version:</strong> ${escapeHtml(context.appVersion)}</li>` : ""}
        </ul>` : "";
    const htmlContent = `
      <p style="margin:0 0 12px;font-size:14px;">
        New Veritas support request — <strong>${escapeHtml(reference)}</strong>
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
        <tr><td style="padding:6px 0;color:#64748b;width:140px;">Type</td><td><strong>${escapeHtml(typeLabel)}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#64748b;">User</td><td>${escapeHtml(user.username || "—")} (${escapeHtml(user.email || req.user.email || "—")})</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;">Role / profile</td><td>${escapeHtml(user.role || "—")} — ${escapeHtml(user.profile || "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;">Reference</td><td>${escapeHtml(reference)}</td></tr>
      </table>
      <h3 style="margin:0 0 8px;font-size:14px;">${escapeHtml(title)}</h3>
      <div style="white-space:pre-wrap;font-size:13px;line-height:1.6;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;">
        ${escapeHtml(description)}
      </div>
      ${contextHtml}
      ${files.length > 0 ? `<p style="margin:16px 0 0;font-size:13px;color:#64748b;">${files.length} attached screenshot(s).</p>` : ""}
    `;
    const attachments = files.map((file, index) => ({
      filename: file.originalname || `screenshot-${index + 1}.png`,
      content: file.buffer,
      contentType: file.mimetype
    }));
    await sendMail({
      to: destination,
      subject: `[Veritas Support] ${typeLabel} — ${title}`,
      title: "Veritas support request",
      htmlContent,
      attachments
    });
    res.json({
      success: true,
      reference,
      type,
      title
    });
  } catch (err) {
    console.error("POST /api/report", err);
    res.status(500).json({
      error: "Error sending the support request."
    });
  }
});
export default router;
