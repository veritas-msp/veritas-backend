import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWindowsInstallerFilenames, WINDOWS_INSTALLER_VERSION } from "../utils/rmmAgentPackage.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(__dirname, "../../veritas-agent");
const msiPath = path.join(agentDir, getWindowsInstallerFilenames().msi);
console.log("=== Build agent Windows RMM ===");
console.log(`Installer version: ${WINDOWS_INSTALLER_VERSION}`);
const cmdBuild = spawnSync("node", ["scripts/build-rmm-windows-cmd.mjs"], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit"
});
if (cmdBuild.status !== 0) {
  process.exit(cmdBuild.status ?? 1);
}
if (process.platform !== "win32") {
  console.warn(".msi build skipped (Windows and WiX are required).");
  process.exit(0);
}
const msiBuild = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/build-rmm-windows-msi.ps1"], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
  env: {
    ...process.env,
    VERITAS_INSTALLER_VERSION: WINDOWS_INSTALLER_VERSION
  }
});
if (msiBuild.status !== 0) {
  console.warn("MSI build skipped (WiX Toolset is required). ZIP and CMD remain available through the API.");
  process.exit(0);
}
if (!fs.existsSync(msiPath)) {
  console.error(`MSI not found after build: ${msiPath}`);
  process.exit(1);
}
console.log("Build completed.");
