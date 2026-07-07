// ───────────────────────────────────────────────
// 📦 Imports
// ───────────────────────────────────────────────
import { getTransporter, veritasTemplate } from "../routes/utils/mailer.js"; 
// getTransporter : fonction qui récupère la config SMTP depuis la base
// veritasTemplate : fonction générant le HTML de l'email avec un en-tête, contenu et pied de page
import { getSettingsMap } from "./settingsHelper.js";

// ───────────────────────────────────────────────
// 📧 Fonction générique pour envoyer un mail
// ───────────────────────────────────────────────
export const sendMail = async ({ to, cc = undefined, subject, title, htmlContent, attachments = [] }) => {
  const transporter = await getTransporter();
  
  // Récupérer l'email d'expéditeur depuis la base ou utiliser la valeur par défaut
  const settings = await getSettingsMap(['BUG_REPORT_EMAIL']);
  const fromEmail = settings.BUG_REPORT_EMAIL || "veritas@psi.fr";

  return transporter.sendMail({
    from: fromEmail,
    to,                     // Destinataire(s) (email ou tableau d'emails)
    cc,
    subject,                // Sujet visible de l'email
    html: veritasTemplate({ // Corps HTML avec structure VERITAS
      title,                // Titre mis en avant dans le mail
      content: htmlContent, // Contenu principal (peut contenir HTML stylé)
    }),
    attachments,            // Fichiers joints (optionnel, tableau d'objets { filename, content, contentType... })
  });
};
