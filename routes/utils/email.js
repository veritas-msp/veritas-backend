// ───────────────────────────────────────────────
// 📦 Imports principaux
// ───────────────────────────────────────────────
import express from "express"; // Framework HTTP
import { sendMail } from "../../utils/sendMail.js"; // Utilitaire centralisé pour l'envoi d'emails
import { veritasTemplate } from "./mailer.js";
import verifyJWT from "../../middleware/auth.js";

const router = express.Router(); // Initialisation du routeur Express
router.use(verifyJWT);

// ───────────────────────────────────────────────
// 📧 POST — Envoi du rapport de monitoring par email
// ───────────────────────────────────────────────
router.post("/send-monitoring-report", async (req, res) => {
  const { emails, html, infos } = req.body;

  // Vérification des champs requis
  if (!emails || !Array.isArray(emails) || !html) {
    return res.status(400).json({ error: "Champs requis manquants." });
  }

  try {
    // Sujet du mail
    const subject = `📊 PSI - Rapport de monitoring`;

    // Contenu HTML affiché dans le corps du mail
    const bodyHTML = veritasTemplate({
      title: ``,
      content: `
        <p>Bonjour,</p>
        <p>
          Veuillez trouver ci-joint le rapport de monitoring établi pour la période : 
          <strong>${infos?.period || "N/A"}</strong>.
        </p>
        <ul style="padding-left: 1em; line-height: 1.6;">
          <li><strong>🏢 Client :</strong> ${infos?.client || "-"}</li>
          <li><strong>🕒 Fréquence :</strong> ${infos?.frequency || "-"}</li>
          <li><strong>🧩 Modules activés :</strong> ${infos?.modules || "Aucun"}</li>
        </ul>
        <p>
          Ce document présente l'état de vos équipements surveillés. Il peut être imprimé, partagé ou archivé.
        </p>
        <p style="font-weight: bold; color: #b91c1c;">
          ⚠️ Ce document est confidentiel et destiné uniquement au destinataire. Toute diffusion ou reproduction non autorisée est déconseillée.
        </p>
        <p>
          Pour toute question complémentaire, notre équipe reste à votre disposition.
        </p>
        <p>
          Cordialement,        
        </p>
        <p>
          L'équipe PSI
        </p>
      `,
    });

    // Envoi de l'email avec pièce jointe
    await sendMail({
      to: emails,
      subject,
      title: "Rapport de monitoring",
      htmlContent: bodyHTML,
      attachments: [
        {
          filename: `rapport-monitoring.html`, // Nom du fichier attaché
          content: html,                      // Contenu HTML fourni par le frontend
          contentType: "text/html",           // Type MIME
        },
      ],
    });

    // Réponse succès
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de l'envoi." });
  }
});

// ───────────────────────────────────────────────
// 📧 POST — Envoi du Compte Rendu AV par email
// ───────────────────────────────────────────────
router.post("/send-crav-report", async (req, res) => {
  const { emails, html, infos } = req.body;

  if (!emails || !Array.isArray(emails) || !html) {
    return res.status(400).json({ error: "Champs requis manquants." });
  }

  try {
    const subject = `🛠️ VERITAS - Rapport CRAV`;
    const bodyHTML = veritasTemplate({
      title: `Compte rendu de visite`,
      content: `
        <p>Bonjour,</p>
        <p>
          Vous trouverez ci-joint le rapport de visite préventive réalisé pour l'établissement <strong>${infos?.client || "-"}</strong>.
        </p>
        <p>
          Date de l'intervention : <strong>${infos?.period || "-"}</strong><br />
          Types de matériels inspectés : <strong>${infos?.modules || "Aucun"}</strong>
        </p>
        <p>
          Le document est joint au format HTML.
        </p>
        <p>
          Cordialement,<br />
          L'équipe PSI
        </p>
      `
    });

    await sendMail({
      to: emails,
      subject,
      title: "Compte rendu CRAV",
      htmlContent: bodyHTML,
      attachments: [
        {
          filename: `rapport-crav.html`,
          content: html,
          contentType: "text/html"
        }
      ]
    });

    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de l'envoi du rapport CRAV." });
  }
});

// ───────────────────────────────────────────────
// 📧 POST /send-campaign-email — Envoi d'email pour une étape de campagne
// ───────────────────────────────────────────────
router.post("/send-campaign-email", async (req, res) => {
  const { to, subject, content, stepId, campaignId, clientId } = req.body;

  // Vérification des champs requis
  if (!to || !subject || !content || !stepId || !campaignId || !clientId) {
    return res.status(400).json({ error: "Champs requis manquants." });
  }

  try {
    // Envoi de l'email - sendMail applique déjà veritasTemplate
    await sendMail({
      to: to,
      subject: subject,
      title: subject,
      htmlContent: content.replace(/\n/g, '<br>')
    });

    // Réponse succès
    res.status(200).json({ success: true, message: "Email envoyé avec succès" });
  } catch (err) {
    console.error('Erreur lors de l\'envoi de l\'email de campagne:', err);
    res.status(500).json({ error: "Erreur lors de l'envoi de l'email.", details: err.message });
  }
});

export default router;

