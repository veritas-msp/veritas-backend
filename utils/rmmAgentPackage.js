import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import archiver from "archiver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, "..");
const AGENT_DIR = path.resolve(__dirname, "../../veritas-agent");
const WINDOWS_SETUP_FILE = "VeritasAgent-Windows-Setup.ps1";
const WINDOWS_LAUNCHER_FILE = "VeritasAgent-Windows-Setup.cmd";
const WINDOWS_ZIP_FILE = "VeritasAgent-Windows-Setup.zip";
const B64_CHUNK_SIZE = 3500;
/** Windows agent semver (logs, API headers, inventory report). */
export const WINDOWS_INSTALLER_VERSION = "1.0.0";
export const VERITAS_AGENT_BUILD_PLACEHOLDER = "__VERITAS_AGENT_BUILD__";

export function applyAgentBuildVersionToScript(content, version = WINDOWS_INSTALLER_VERSION) {
  let next = String(content || "").replaceAll(VERITAS_AGENT_BUILD_PLACEHOLDER, version);
  return next.replace(/\$agentVersion\s*=\s*['"][^'"]*['"]/g, `$agentVersion = '${version}'`);
}

export function getWindowsInstallerFilenames() {
  return {
    cmd: WINDOWS_LAUNCHER_FILE,
    zip: WINDOWS_ZIP_FILE,
    msi: "VeritasAgent-Windows-Setup.msi",
  };
}

function resolveAgentFile(name) {
  const filePath = path.join(AGENT_DIR, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Agent file not found: ${name}`);
  }
  return filePath;
}

export function getWindowsSetupScriptPath() {
  return resolveAgentFile(WINDOWS_SETUP_FILE);
}

export function getWindowsMsiPath() {
  const names = getWindowsInstallerFilenames();
  return resolveAgentFile(names.msi);
}

export function syncEmbeddedAgentScripts() {
  const setupPath = getWindowsSetupScriptPath();
  const inventory = fs
    .readFileSync(path.join(AGENT_DIR, "Get-VeritasInventory.ps1"), "utf8")
    .replace(/\r/g, "");
  const heartbeat = fs
    .readFileSync(path.join(AGENT_DIR, "Invoke-VeritasHeartbeat.ps1"), "utf8")
    .replace(/\r/g, "");

  let setup = fs.readFileSync(setupPath, "utf8");
  const invMarker = "$inventoryScript = @'";
  const tailMarker = "    Set-Content -Path $invDst -Value $inventoryScript -Encoding UTF8";
  const invStart = setup.indexOf(invMarker);
  const tailStart = setup.lastIndexOf(tailMarker);

  if (invStart < 0 || tailStart < 0 || tailStart <= invStart) {
    throw new Error("Invalid setup PS1 structure (embed markers not found)");
  }

  const head = setup.slice(0, invStart + invMarker.length);
  const tail = setup.slice(tailStart);
  setup = `${head}\n${inventory}\n'@\n\n$heartbeatScript = @'\n${heartbeat}\n'@\n\n${tail}`;
  setup = applyAgentBuildVersionToScript(setup);
  fs.writeFileSync(setupPath, setup, "utf8");

  const heartbeatPath = path.join(AGENT_DIR, "Invoke-VeritasHeartbeat.ps1");
  if (fs.existsSync(heartbeatPath)) {
    fs.writeFileSync(
      heartbeatPath,
      applyAgentBuildVersionToScript(fs.readFileSync(heartbeatPath, "utf8")),
      "utf8"
    );
  }

  return setupPath;
}

function toPowerShellEncodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function buildDecodeEncodedCommand(chunkCount) {
  const b64Expr = Array.from({ length: chunkCount }, (_, index) => {
    const key = `_VA64_${String(index).padStart(3, "0")}`;
    return `$env:${key}`;
  }).join("+");

  const decodeScript = [
    `$b64=${b64Expr}`,
    "if([string]::IsNullOrWhiteSpace($b64)){Write-Host 'ERROR: incomplete installer.' -ForegroundColor Red; exit 1}",
    "$out=$env:VERITAS_SETUP_OUT",
    "if([string]::IsNullOrWhiteSpace($out)){Write-Host 'ERROR: missing PS1 path.' -ForegroundColor Red; exit 1}",
    "try{",
    "[IO.File]::WriteAllText($out,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)),[Text.UTF8Encoding]::new($false))",
    "}catch{",
    "Write-Host ('ERROR decoding: '+$_.Exception.Message) -ForegroundColor Red; exit 1",
    "}",
  ].join("; ");

  return toPowerShellEncodedCommand(decodeScript);
}

function buildCmdBootstrapBlock() {
  return [
    "if not \"%~1\"==\"stay\" (",
    "    start \"Veritas Agent - Installation\" cmd /k call \"%~f0\" stay",
    "    exit /b 0",
    ")",
  ];
}

function buildCmdElevationBlock() {
  return [
    "net session >nul 2>&1",
    "if %errorLevel% equ 0 goto :after_elevate",
    "echo.",
    "echo === Administrator rights required ===",
    "echo.",
    "echo A UAC prompt will open: click Yes.",
    "echo Installation continues in the new administrator window.",
    "echo Otherwise: right-click this file ^> Run as administrator.",
    "echo.",
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Start-Process -FilePath '%~f0' -ArgumentList 'stay' -WorkingDirectory '%~dp0' -Verb RunAs\"",
    "echo.",
    "echo If UAC was accepted, follow the administrator window.",
    "pause",
    "exit /b 0",
    ":after_elevate",
  ];
}

function buildCmdFinishBlock() {
  return [
    ":finish",
    "echo.",
    "echo ==========================================",
    "if !ERR! equ 0 (",
    "    echo   INSTALLATION COMPLETED SUCCESSFULLY",
    "    echo [%date% %time%] Success >> \"%CMDLOG%\"",
    ") else (",
    "    echo   INSTALLATION FAILED",
    "    echo [%date% %time%] Failure code %ERR% >> \"%CMDLOG%\"",
    ")",
    "echo ==========================================",
    "echo.",
    "echo Detailed logs:",
    "echo   %TEMP%\\VeritasAgent-cmd.log",
    "echo   %TEMP%\\VeritasAgent-install.log",
    "echo.",
    "echo This window stays open for review.",
    "echo Press any key to close...",
    "pause >nul",
    "",
  ];
}

/** Minimal launcher for ZIP archive (.cmd + colocated .ps1, no base64 payload). */
export function buildSimpleWindowsLauncherCmd() {
  return [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    ...buildCmdBootstrapBlock(),
    "title Veritas Agent - Installation",
    "cd /d \"%~dp0\"",
    "set ERR=0",
    "set \"CMDLOG=%TEMP%\\VeritasAgent-cmd.log\"",
    `echo [%date% %time%] Starting installer ${WINDOWS_INSTALLER_VERSION} (zip) >> \"%CMDLOG%\"`,
    "",
    ...buildCmdElevationBlock(),
    "",
    "echo.",
    "echo === Veritas Agent Installation ===",
    `echo Installer ${WINDOWS_INSTALLER_VERSION}`,
    "echo.",
    "",
    "set \"SETUP_PS1=%~dp0VeritasAgent-Windows-Setup.ps1\"",
    "if not exist \"!SETUP_PS1!\" (",
    "    echo ERROR: VeritasAgent-Windows-Setup.ps1 not found in the same folder.",
    "    echo Extract the full ZIP contents before running the .cmd.",
    "    set ERR=1",
    "    goto :finish",
    ")",
    "echo [%date% %time%] Launching colocated PS1 >> \"%CMDLOG%\"",
    "echo Starting PowerShell script...",
    "echo.",
    "set VERITAS_LAUNCHED_BY_CMD=1",
    "powershell -NoProfile -ExecutionPolicy Bypass -File \"!SETUP_PS1!\"",
    "if errorlevel 1 set ERR=1",
    "echo.",
    "echo PowerShell script finished.",
    "",
    ...buildCmdFinishBlock(),
  ].join("\r\n");
}

export function buildWindowsLauncherCmd() {
  syncEmbeddedAgentScripts();
  const ps1 = fs.readFileSync(getWindowsSetupScriptPath(), "utf8");
  const b64 = Buffer.from(ps1, "utf8").toString("base64");
  const chunks = [];
  for (let i = 0; i < b64.length; i += B64_CHUNK_SIZE) {
    chunks.push(b64.slice(i, i + B64_CHUNK_SIZE));
  }

  const chunkSets = chunks
    .map((chunk, index) => `set "_VA64_${String(index).padStart(3, "0")}=${chunk}"`)
    .join("\r\n");

  const encodedDecode = buildDecodeEncodedCommand(chunks.length);

  const batch = [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    ...buildCmdBootstrapBlock(),
    "title Veritas Agent - Installation",
    "cd /d \"%~dp0\"",
    "set ERR=0",
    "set \"CMDLOG=%TEMP%\\VeritasAgent-cmd.log\"",
    `echo [%date% %time%] Starting installer ${WINDOWS_INSTALLER_VERSION} >> \"%CMDLOG%\"`,
    "",
    ...buildCmdElevationBlock(),
    "",
    "echo.",
    "echo === Veritas Agent Installation ===",
    `echo Installer ${WINDOWS_INSTALLER_VERSION}`,
    "echo.",
    "",
    "set \"SETUP_PS1=%~dp0VeritasAgent-Windows-Setup.ps1\"",
    "if exist \"!SETUP_PS1!\" (",
    "    echo [%date% %time%] Local mode: colocated PS1 >> \"%CMDLOG%\"",
    "    echo Starting PowerShell script...",
    "    echo.",
    "    set VERITAS_LAUNCHED_BY_CMD=1",
    "    powershell -NoProfile -ExecutionPolicy Bypass -File \"!SETUP_PS1!\"",
    "    if errorlevel 1 set ERR=1",
    "    echo.",
    "    echo PowerShell script finished.",
    "    goto :finish",
    ")",
    "",
    "set \"SETUP_PS1=%TEMP%\\VeritasAgent-Setup-%RANDOM%.ps1\"",
    "set VERITAS_LAUNCHED_BY_CMD=1",
    "set \"VERITAS_SETUP_OUT=!SETUP_PS1!\"",
    "echo [%date% %time%] PS1 target: !SETUP_PS1! >> \"%CMDLOG%\"",
    "",
    chunkSets,
    `echo [%date% %time%] Base64 chunks loaded: ${chunks.length} >> \"%CMDLOG%\"`,
    "",
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedDecode}`,
    "",
    "if errorlevel 1 (",
    "    echo [%date% %time%] Base64 decode failed >> \"%CMDLOG%\"",
    "    set ERR=1",
    "    goto :finish",
    ")",
    "",
    "if not exist \"!SETUP_PS1!\" (",
    "    echo ERROR: PowerShell script not created in %%TEMP%%.",
    "    echo [%date% %time%] PS1 file missing after decode >> \"%CMDLOG%\"",
    "    set ERR=1",
    "    goto :finish",
    ")",
    "",
    "echo [%date% %time%] PS1 extracted, launching... >> \"%CMDLOG%\"",
    "echo Starting PowerShell script...",
    "echo.",
    "powershell -NoProfile -ExecutionPolicy Bypass -File \"!SETUP_PS1!\"",
    "if errorlevel 1 set ERR=1",
    "echo.",
    "echo PowerShell script finished.",
    "del \"!SETUP_PS1!\" 2>nul",
    "",
    ...buildCmdFinishBlock(),
  ].join("\r\n");

  return batch;
}

export function streamWindowsSetupZip(res) {
  syncEmbeddedAgentScripts();
  const ps1 = fs.readFileSync(getWindowsSetupScriptPath(), "utf8");
  const cmd = buildSimpleWindowsLauncherCmd();
  const names = getWindowsInstallerFilenames();

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("X-Veritas-Installer-Version", WINDOWS_INSTALLER_VERSION);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${names.zip}"`
  );

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  });
  archive.pipe(res);
  archive.append(cmd, { name: WINDOWS_LAUNCHER_FILE });
  archive.append(ps1, { name: WINDOWS_SETUP_FILE });
  archive.finalize();
}

export function streamWindowsSetupScript(res) {
  const content = buildWindowsLauncherCmd();
  const names = getWindowsInstallerFilenames();
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("X-Veritas-Installer-Version", WINDOWS_INSTALLER_VERSION);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${names.cmd}"`
  );
  res.send(content);
}

export function ensureWindowsMsiBuilt() {
  if (agentMsiAvailable()) {
    return getWindowsMsiPath();
  }
  if (process.platform !== "win32") {
    throw new Error("MSI installer unavailable on this server (Windows + WiX required)");
  }

  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(BACKEND_DIR, "scripts/build-rmm-windows-msi.ps1"),
    ],
    {
      cwd: BACKEND_DIR,
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        VERITAS_INSTALLER_VERSION: WINDOWS_INSTALLER_VERSION,
      },
    }
  );

  if (result.status !== 0 || !agentMsiAvailable()) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").pop();
    throw new Error(
      detail ||
        "MSI build failed — install WiX Toolset (https://wixtoolset.org/) and retry"
    );
  }

  return getWindowsMsiPath();
}

export function streamWindowsSetupMsi(res) {
  const filePath = ensureWindowsMsiBuilt();
  const names = getWindowsInstallerFilenames();
  res.setHeader("Content-Type", "application/x-msi");
  res.setHeader("X-Veritas-Installer-Version", WINDOWS_INSTALLER_VERSION);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${names.msi}"`
  );
  fs.createReadStream(filePath).pipe(res);
}

export function agentPackageAvailable() {
  try {
    getWindowsSetupScriptPath();
    return true;
  } catch {
    return false;
  }
}

export function agentMsiAvailable() {
  try {
    getWindowsMsiPath();
    return true;
  } catch {
    return false;
  }
}
