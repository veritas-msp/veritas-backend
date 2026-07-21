import nodemailer from "nodemailer";
import { getSettingsMap } from '../../utils/settingsHelper.js';
const isProduction = () => process.env.NODE_ENV === "production";
async function getSMTPSettings() {
  try {
    const settings = await getSettingsMap(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']);
    return {
      host: settings.SMTP_HOST || '',
      port: Number(settings.SMTP_PORT) || 587,
      user: settings.SMTP_USER || '',
      pass: settings.SMTP_PASS || ''
    };
  } catch (error) {
    return null;
  }
}
export async function isSmtpConfigured() {
  const smtpSettings = await getSMTPSettings();
  return Boolean(smtpSettings?.host);
}
function createLogTransporter() {
  return nodemailer.createTransport({
    jsonTransport: true
  });
}
export async function getTransporter() {
  const smtpSettings = await getSMTPSettings();
  if (!smtpSettings || !smtpSettings.host) {
    if (isProduction()) {
      throw new Error("Configuration SMTP manquante");
    }
    console.warn("[mail] SMTP not configured — journal mode (emails not sent). Configure Settings → Email.");
    return createLogTransporter();
  }
  const port = smtpSettings.port;
  return nodemailer.createTransport({
    host: smtpSettings.host,
    port,
    secure: port === 465,
    auth: smtpSettings.user ? {
      user: smtpSettings.user,
      pass: smtpSettings.pass
    } : undefined,
    tls: {
      rejectUnauthorized: false
    }
  });
}
export const veritasTemplate = ({
  title,
  content
}) => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6fa;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f4f6fa;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px;">
          <tr>
            <td align="center" style="background-color: #162641; background: linear-gradient(160deg, #0f1c2e 0%, #162641 60%, #1a3060 100%); border-radius: 12px 12px 0 0; padding: 28px 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="width: 38px; height: 38px; background-color: #2b5fab; border-radius: 8px; font-size: 18px; font-weight: 800; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                    V
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-top: 12px; font-size: 17px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #e8edf5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                    Veritas
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color: #ffffff; border: 1px solid #dde3ed; border-top: none; border-radius: 0 0 12px 12px; padding: 32px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
              <h1 style="margin: 0 0 20px; font-size: 18px; font-weight: 700; color: #10233c; line-height: 1.35;">
                ${title}
              </h1>
              <div style="font-size: 15px; color: #374a5e; line-height: 1.6;">
                ${content}
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 20px 12px 0; font-size: 12px; color: #6b7a90; line-height: 1.5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
              This email was sent automatically from the Veritas platform.<br />
              Please do not reply directly to this message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};
