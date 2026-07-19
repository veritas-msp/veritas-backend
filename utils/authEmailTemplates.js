/**
 * Contenu HTML e-mails authentication (inlistyles, compatibclients mail).
 */

export function forgotPasswordEmailContent({ resetLink }) {
  return `
    <p style="margin: 0 0 16px; font-size: 15px; color: #374a5e; line-height: 1.6;">Bonjour,</p>
    <p style="margin: 0 0 24px; font-size: 15px; color: #374a5e; line-height: 1.6;">
      Vous avez demandé la réinitialisation de votre mot de passe Veritas.
      Utilisez le bouton ci-dessous pour en choisir un nouveau.
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 24px;">
      <tr>
        <td align="center" style="border-radius: 8px; background-color: #2b5fab;">
          <a href="${resetLink}" target="_blank" rel="noopener noreferrer"
            style="display: inline-block; padding: 13px 28px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            Réinitialiser mon mot de passe
          </a>
        </td>
      </tr>
    </table>
    <p style="margin: 0 0 12px; font-size: 13px; color: #6b7a90; line-height: 1.5;">
      Ce lien expire dans <strong style="color: #10233c;">15 minutes</strong>.
    </p>
    <p style="margin: 0 0 0; font-size: 12px; color: #9ca3af; line-height: 1.6; word-break: break-all;">
      Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur&nbsp;:<br>
      <a href="${resetLink}" style="color: #2b5fab; text-decoration: underline;">${resetLink}</a>
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 24px 0;">
      <tr>
        <td style="border-top: 1px solid #e4e8ee; font-size: 0; line-height: 0;">&nbsp;</td>
      </tr>
    </table>
    <p style="margin: 0; font-size: 13px; color: #6b7a90; line-height: 1.5;">
      Si vous n'êtes pas à l'origine de cette demande, ignorez cet email&nbsp;: votre mot de passe restera inchangé.
    </p>
  `;
}

export function portalInviteEmailContent({ activateLink, contactName }) {
  const greeting = contactName ? `Bonjour ${contactName},` : "Bonjour,";
  return `
    <p style="margin: 0 0 16px; font-size: 15px; color: #374a5e; line-height: 1.6;">${greeting}</p>
    <p style="margin: 0 0 24px; font-size: 15px; color: #374a5e; line-height: 1.6;">
      Votre prestataire vous a ouvert un accès à l'espace client Veritas.
      Cliquez sur le bouton ci-dessous pour choisir votre mot de passe et activer votre compte.
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 24px;">
      <tr>
        <td align="center" style="border-radius: 8px; background-color: #2b5fab;">
          <a href="${activateLink}" target="_blank" rel="noopener noreferrer"
            style="display: inline-block; padding: 13px 28px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            Activer mon accès
          </a>
        </td>
      </tr>
    </table>
    <p style="margin: 0 0 12px; font-size: 13px; color: #6b7a90; line-height: 1.5;">
      Ce lien expire dans <strong style="color: #10233c;">72 heures</strong>.
    </p>
    <p style="margin: 0 0 0; font-size: 12px; color: #9ca3af; line-height: 1.6; word-break: break-all;">
      Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur&nbsp;:<br>
      <a href="${activateLink}" style="color: #2b5fab; text-decoration: underline;">${activateLink}</a>
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 24px 0;">
      <tr>
        <td style="border-top: 1px solid #e4e8ee; font-size: 0; line-height: 0;">&nbsp;</td>
      </tr>
    </table>
    <p style="margin: 0; font-size: 13px; color: #6b7a90; line-height: 1.5;">
      Si vous n'attendiez pas cet accès, ignorez cet email ou contactez votre prestataire.
    </p>
  `;
}
