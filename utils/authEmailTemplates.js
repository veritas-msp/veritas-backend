export function forgotPasswordEmailContent({
  resetLink
}) {
  return `
    <p style="margin: 0 0 16px; font-size: 15px; color: #374a5e; line-height: 1.6;">Hello,</p>
    <p style="margin: 0 0 24px; font-size: 15px; color: #374a5e; line-height: 1.6;">
      You requested a reset of your Veritas password.
      Use the button below to choose a new one.
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 24px;">
      <tr>
        <td align="center" style="border-radius: 8px; background-color: #2b5fab;">
          <a href="${resetLink}" target="_blank" rel="noopener noreferrer"
            style="display: inline-block; padding: 13px 28px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            Reset my password
          </a>
        </td>
      </tr>
    </table>
    <p style="margin: 0 0 12px; font-size: 13px; color: #6b7a90; line-height: 1.5;">
      This link expires in <strong style="color: #10233c;">15 minutes</strong>.
    </p>
    <p style="margin: 0 0 0; font-size: 12px; color: #9ca3af; line-height: 1.6; word-break: break-all;">
      If the button does not work, copy this link into your browser:<br>
      <a href="${resetLink}" style="color: #2b5fab; text-decoration: underline;">${resetLink}</a>
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 24px 0;">
      <tr>
        <td style="border-top: 1px solid #e4e8ee; font-size: 0; line-height: 0;">&nbsp;</td>
      </tr>
    </table>
    <p style="margin: 0; font-size: 13px; color: #6b7a90; line-height: 1.5;">
      If you did not make this request, ignore this email: your password will remain unchanged.
    </p>
  `;
}
export function portalInviteEmailContent({
  activateLink,
  contactName
}) {
  const greeting = contactName ? `Hello ${contactName},` : "Hello,";
  return `
    <p style="margin: 0 0 16px; font-size: 15px; color: #374a5e; line-height: 1.6;">${greeting}</p>
    <p style="margin: 0 0 24px; font-size: 15px; color: #374a5e; line-height: 1.6;">
      Your service provider has granted you access to the Veritas client portal.
      Click the button below to choose your password and activate your account.
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 24px;">
      <tr>
        <td align="center" style="border-radius: 8px; background-color: #2b5fab;">
          <a href="${activateLink}" target="_blank" rel="noopener noreferrer"
            style="display: inline-block; padding: 13px 28px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            Activate my access
          </a>
        </td>
      </tr>
    </table>
    <p style="margin: 0 0 12px; font-size: 13px; color: #6b7a90; line-height: 1.5;">
      This link expires in <strong style="color: #10233c;">72 hours</strong>.
    </p>
    <p style="margin: 0 0 0; font-size: 12px; color: #9ca3af; line-height: 1.6; word-break: break-all;">
      If the button does not work, copy this link into your browser:<br>
      <a href="${activateLink}" style="color: #2b5fab; text-decoration: underline;">${activateLink}</a>
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 24px 0;">
      <tr>
        <td style="border-top: 1px solid #e4e8ee; font-size: 0; line-height: 0;">&nbsp;</td>
      </tr>
    </table>
    <p style="margin: 0; font-size: 13px; color: #6b7a90; line-height: 1.5;">
      If you were not expecting this access, ignore this email or contact your service provider.
    </p>
  `;
}
