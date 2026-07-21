import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
export function generateMfaSecret() {
  return generateSecret();
}
export function buildOtpAuthUrl(email, secret) {
  return generateURI({
    issuer: "Veritas",
    label: email,
    secret
  });
}
export async function generateQrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl);
}
export function verifyTotp(code, secret) {
  if (!code || !secret) return false;
  const token = String(code).replace(/\s/g, "");
  const result = verifySync({
    token,
    secret,
    epochTolerance: 1
  });
  return Boolean(result?.valid);
}
