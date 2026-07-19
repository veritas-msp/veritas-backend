import crypto from "crypto";
import { signSessionToken } from "./authSession.js";
import { getPrimaryFrontendBaseUrl } from "./envFile.js";
import { sendMail } from "./sendMail.js";
import { portalInviteEmailContent } from "./authEmailTemplates.js";

export function passwordFingerprint(passwordHash) {
  return crypto.createHash("sha256").update(String(passwordHash || "")).digest("hex").slice(0, 16);
}

export function buildPortalInviteLink(userId, email, passwordHash) {
  const token = signSessionToken(
    { id: userId, email, purpose: "portal_invite", fp: passwordFingerprint(passwordHash) },
    "72h"
  );
  return `${getPrimaryFrontendBaseUrl()}/activate-portal#token=${token}`;
}

export async function sendPortalInviteEmail({ userId, email, contactName, passwordHash }) {
  const activateLink = buildPortalInviteLink(userId, email, passwordHash);
  await sendMail({
    to: email,
    subject: "Activez votre accès à l'espace client Veritas",
    title: "Activation de votre compte",
    htmlContent: portalInviteEmailContent({ activateLink, contactName }),
  });
}
