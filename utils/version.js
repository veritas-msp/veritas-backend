import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
);

export const APP_NAME = "Veritas";

export function getAppVersion() {
  return pkg.version || "0.0.0";
}
