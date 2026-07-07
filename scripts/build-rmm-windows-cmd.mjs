import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildWindowsLauncherCmd,
  syncEmbeddedAgentScripts,
  WINDOWS_INSTALLER_VERSION,
} from "../utils/rmmAgentPackage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(__dirname, "../../veritas-agent");
const outPath = path.join(agentDir, "VeritasAgent-Windows-Setup.cmd");

syncEmbeddedAgentScripts();
const content = buildWindowsLauncherCmd();
fs.writeFileSync(outPath, content, "utf8");
console.log(`Écrit: ${outPath}`);
console.log(`Version: ${WINDOWS_INSTALLER_VERSION}`);
console.log(`Taille: ${content.length} octets`);
