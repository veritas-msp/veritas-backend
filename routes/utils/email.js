import express from "express";
import { sendMail } from "../../utils/sendMail.js";
import { veritasTemplate } from "./mailer.js";
import verifyJWT from "../../middleware/auth.js";
const router = express.Router();
router.use(verifyJWT);
router.post("/send-monitoring-report", async (req, res) => {
  const {
    emails,
    html,
    infos
  } = req.body;
  if (!emails || !Array.isArray(emails) || !html) {
    return res.status(400).json({
      error: "Required fields missing."
    });
  }
  try {
    const subject = `📊 Veritas - Monitoring report`;
    const bodyHTML = veritasTemplate({
      title: ``,
      content: `
        <p>Hello,</p>
        <p>
          Please find attached the monitoring report for the period:
          <strong>${infos?.period || "N/A"}</strong>.
        </p>
        <ul style="padding-left: 1em; line-height: 1.6;">
          <li><strong>🏢 Client:</strong> ${infos?.client || "-"}</li>
          <li><strong>🕒 Frequency:</strong> ${infos?.frequency || "-"}</li>
          <li><strong>🧩 Enabled modules:</strong> ${infos?.modules || "None"}</li>
        </ul>
        <p>
          This document summarizes the status of your monitored equipment. It can be printed, shared, or archived.
        </p>
        <p style="font-weight: bold; color: #b91c1c;">
          ⚠️ This document is confidential and intended solely for the recipient. Unauthorized distribution or reproduction is discouraged.
        </p>
        <p>
          If you have any questions, our team remains at your disposal.
        </p>
        <p>
          Best regards,
        </p>
        <p>
          The Veritas team
        </p>
      `
    });
    await sendMail({
      to: emails,
      subject,
      title: "Monitoring report",
      htmlContent: bodyHTML,
      attachments: [{
        filename: `monitoring-report.html`,
        content: html,
        contentType: "text/html"
      }]
    });
    res.status(200).json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Error sending"
    });
  }
});
router.post("/send-crav-report", async (req, res) => {
  const {
    emails,
    html,
    infos
  } = req.body;
  if (!emails || !Array.isArray(emails) || !html) {
    return res.status(400).json({
      error: "Required fields missing."
    });
  }
  try {
    const subject = `🛠️ Veritas - Site visit report`;
    const bodyHTML = veritasTemplate({
      title: `Site visit report`,
      content: `
        <p>Hello,</p>
        <p>
          Please find attached the preventive site visit report for <strong>${infos?.client || "-"}</strong>.
        </p>
        <p>
          Visit date: <strong>${infos?.period || "-"}</strong><br />
          Equipment types inspected: <strong>${infos?.modules || "None"}</strong>
        </p>
        <p>
          The document is attached as HTML.
        </p>
        <p>
          Best regards,<br />
          The Veritas team
        </p>
      `
    });
    await sendMail({
      to: emails,
      subject,
      title: "Site visit report",
      htmlContent: bodyHTML,
      attachments: [{
        filename: `site-visit-report.html`,
        content: html,
        contentType: "text/html"
      }]
    });
    res.status(200).json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: "Error sending CRAV report"
    });
  }
});
router.post("/send-campaign-email", async (req, res) => {
  const {
    to,
    subject,
    content,
    stepId,
    campaignId,
    clientId
  } = req.body;
  if (!to || !subject || !content || !stepId || !campaignId || !clientId) {
    return res.status(400).json({
      error: "Required fields missing."
    });
  }
  try {
    await sendMail({
      to: to,
      subject: subject,
      title: subject,
      htmlContent: content.replace(/\n/g, '<br>')
    });
    res.status(200).json({
      success: true,
      message: "Email sent successfully"
    });
  } catch (err) {
    console.error('Error sending campaign email:', err);
    res.status(500).json({
      error: "Error sending email",
      details: err.message
    });
  }
});
export default router;
