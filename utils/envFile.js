import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ENV_PATH = path.join(__dirname, "..", ".env");
const FRONTEND_ENV_PATH = path.join(__dirname, "..", "..", "veritas-frontend", ".env");

const FILE_HEADERS = {
  backend: "# Veritas Backend — configuration generated / updated by the setup wizard",
  frontend: "# Veritas Frontend — configuration generated / updated by the setup wizard",
};

/** Reads a .env file and returns a key/value object. */
function readEnvFileAt(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const content = fs.readFileSync(filePath, "utf8");
  const result = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

/** Merges keys into a .env file. */
function writeEnvFileAt(filePath, updates, headerKey = "backend") {
  const current = readEnvFileAt(filePath);
  const merged = { ...current, ...updates };

  const lines = [FILE_HEADERS[headerKey] || FILE_HEADERS.backend];
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null) continue;
    const safe = String(value).includes(" ") ? `"${String(value)}"` : String(value);
    lines.push(`${key}=${safe}`);
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return merged;
}

/** Writes the backend .env and reloads process.env. */
export function writeEnvFile(updates) {
  const merged = writeEnvFileAt(BACKEND_ENV_PATH, updates, "backend");

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && value !== null) {
      process.env[key] = String(value);
    }
  }

  return merged;
}

/** Writes the frontend .env (REACT_APP_*). */
export function writeFrontendEnvFile(updates) {
  return writeEnvFileAt(FRONTEND_ENV_PATH, updates, "frontend");
}

/** First URL when multiple values are comma-separated. */
export function getPrimaryFrontendBaseUrl() {
  const raw = process.env.FRONTEND_BASE_URL || "http://localhost:3000";
  return String(raw).split(",")[0].trim().replace(/\/+$/, "");
}
