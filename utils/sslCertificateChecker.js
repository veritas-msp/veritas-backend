import tls from "tls";

function normalizeHost(raw) {
  return String(raw || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .split(":")[0]
    .toLowerCase();
}

/**
 * Checks a TLS certificate on a host (port 443 by default).
 * @returns {Promise<object>}
 */
export function checkSslCertificate(host, port = 443, timeoutMs = 12000) {
  const hostname = normalizeHost(host);
  if (!hostname) {
    return Promise.reject(new Error("Nom d'hôte invalide"));
  }

  const numericPort = Number(port) || 443;

  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: hostname,
        port: numericPort,
        servername: hostname,
        rejectUnauthorized: false,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          socket.end();

          if (!cert || Object.keys(cert).length === 0 || !cert.valid_to) {
            resolve({
              hostname,
              port: numericPort,
              valid: false,
              error: "Certificat introuvable",
              lastChecked: new Date().toISOString(),
            });
            return;
          }

          const expiration = new Date(cert.valid_to);
          const daysRemaining = Math.ceil((expiration.getTime() - Date.now()) / 86400000);
          const protocol =
            typeof socket.getProtocol === "function" ? socket.getProtocol() : null;

          resolve({
            hostname,
            port: numericPort,
            valid: socket.authorized !== false && daysRemaining >= 0,
            subject: cert.subject?.CN || cert.subjectaltname || hostname,
            subjectCN: cert.subject?.CN || null,
            subjectO: cert.subject?.O || null,
            issuer: cert.issuer?.O || cert.issuer?.CN || null,
            issuerCN: cert.issuer?.CN || null,
            issuerO: cert.issuer?.O || null,
            validFrom: cert.valid_from ? new Date(cert.valid_from).toISOString() : null,
            expiration: expiration.toISOString(),
            daysRemaining,
            serialNumber: cert.serialNumber || null,
            fingerprint: cert.fingerprint256 || cert.fingerprint || null,
            subjectAltNames: cert.subjectaltname || null,
            protocol,
            authorized: socket.authorized,
            authorizationError: socket.authorizationError?.message || null,
            lastChecked: new Date().toISOString(),
          });
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      }
    );

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`Délai dépassé pour ${hostname}:${numericPort}`));
    });

    socket.on("error", (err) => {
      reject(err);
    });
  });
}

export function getSslExpiryStatus(expiration, warnDays = 30) {
  if (!expiration) return "unknown";
  const expiry = new Date(expiration);
  if (Number.isNaN(expiry.getTime())) return "unknown";
  const now = new Date();
  if (expiry < now) return "expired";
  const warnDate = new Date(now);
  warnDate.setDate(warnDate.getDate() + warnDays);
  if (expiry <= warnDate) return "expiring_soon";
  return "valid";
}

export const DEFAULT_SSL_CHECK_INTERVAL_HOURS = 24;

export function resolveSslCheckIntervalHours(data) {
  const hours = Number(data?.checkIntervalHours);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SSL_CHECK_INTERVAL_HOURS;
}

export function isSslCheckStale(data) {
  if (!data?.lastChecked) return true;
  const last = new Date(data.lastChecked);
  if (Number.isNaN(last.getTime())) return true;
  const intervalMs = resolveSslCheckIntervalHours(data) * 3600000;
  return Date.now() - last.getTime() >= intervalMs;
}
