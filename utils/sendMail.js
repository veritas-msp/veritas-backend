// ───────────────────────────────────────────────
// 📦 Imports
// ───────────────────────────────────────────────
import { getTransporter, isSmtpConfigured, veritasTemplate } from "../routes/utils/mailer.js"; 
// getTransporter: loads SMTP config from the database
// veritasTemplate: builds the email HTML with header, body, and footer
import { getSettingsMap } from "./settingsHelper.js";

// ───────────────────────────────────────────────
// 📧 Generic mail sender
// ───────────────────────────────────────────────
export const sendMail = async ({ to, cc = undefined, subject, title, htmlContent, attachments = [] }) => {
  const smtpReady = await isSmtpConfigured();
  const transporter = await getTransporter();
  
  // Expéditeur = adresse configurée, sinon compte SMTP (comme /api/email-test)
  const settings = await getSettingsMap(['BUG_REPORT_EMAIL', 'SMTP_USER']);
  let fromEmail = settings.BUG_REPORT_EMAIL || settings.SMTP_USER;
  if (!fromEmail) {
    if (smtpReady || process.env.NODE_ENV === "production") {
      throw new Error("Adresse expéditeur manquante (BUG_REPORT_EMAIL ou SMTP_USER)");
    }
    fromEmail = "noreply@localhost";
  }

  const info = await transporter.sendMail({
    from: fromEmail,
    to,                     // Recipient(s) (email or array of emails)
    cc,
    subject,                // Visible email subject
    html: veritasTemplate({ // HTML body with VERITAS layout
      title,                // Title shown at the top of the email
      content: htmlContent, // Main content (may include styled HTML)
    }),
    attachments,            // Attachments (optional array of { filename, content, contentType... })
  });

  if (!smtpReady) {
    console.info(`[mail:dev] ${subject} → ${to}`);
    if (typeof info?.message === "string") {
      try {
        const parsed = JSON.parse(info.message);
        const href = String(parsed.html || "").match(/href="(https?:[^"]+)"/i)?.[1];
        if (href) console.info(`[mail:dev] lien: ${href}`);
      } catch {
        /* ignore */
      }
    }
  }

  return { ...info, skipped: !smtpReady };
};
