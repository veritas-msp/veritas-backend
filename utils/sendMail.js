import { getTransporter, isSmtpConfigured, veritasTemplate } from "../routes/utils/mailer.js";
import { getSettingsMap } from "./settingsHelper.js";
export const sendMail = async ({
  to,
  cc = undefined,
  subject,
  title,
  htmlContent,
  attachments = []
}) => {
  const smtpReady = await isSmtpConfigured();
  const transporter = await getTransporter();
  const settings = await getSettingsMap(['BUG_REPORT_EMAIL', 'SMTP_USER']);
  let fromEmail = settings.BUG_REPORT_EMAIL || settings.SMTP_USER;
  if (!fromEmail) {
    if (smtpReady || process.env.NODE_ENV === "production") {
      throw new Error("Sender address is missing (BUG_REPORT_EMAIL or SMTP_USER)");
    }
    fromEmail = "noreply@localhost";
  }
  const info = await transporter.sendMail({
    from: fromEmail,
    to,
    cc,
    subject,
    html: veritasTemplate({
      title,
      content: htmlContent
    }),
    attachments
  });
  if (!smtpReady) {
    console.info(`[mail:dev] ${subject} → ${to}`);
    if (typeof info?.message === "string") {
      try {
        const parsed = JSON.parse(info.message);
        const href = String(parsed.html || "").match(/href="(https?:[^"]+)"/i)?.[1];
        if (href) console.info(`[mail:dev] link: ${href}`);
      } catch {}
    }
  }
  return {
    ...info,
    skipped: !smtpReady
  };
};
