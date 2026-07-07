#Requires -Version 5.1
param(
    [string]$Version = $env:VERITAS_INSTALLER_VERSION
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Split-Path -Parent $scriptDir
$agentDir = Resolve-Path (Join-Path $backendDir '..\veritas-agent')
$msiDir = Join-Path $agentDir 'msi'
$staging = Join-Path $agentDir 'msi-staging'

if ([string]::IsNullOrWhiteSpace($Version)) {
    Push-Location $backendDir
    try {
        $Version = & node --input-type=module -e "import { WINDOWS_INSTALLER_VERSION } from './utils/rmmAgentPackage.js'; process.stdout.write(WINDOWS_INSTALLER_VERSION);"
    } finally {
        Pop-Location
    }
    if ([string]::IsNullOrWhiteSpace($Version)) {
        $Version = '1.0.0'
    }
}

$outMsi = Join-Path $agentDir 'VeritasAgent-Windows-Setup.msi'

function Find-WixBin {
    $candidates = @()
    if ($env:WIX) {
        $candidates += Join-Path $env:WIX 'bin'
    }
    @(
        "${env:ProgramFiles(x86)}\WiX Toolset v3.14\bin",
        "${env:ProgramFiles(x86)}\WiX Toolset v3.11\bin",
        "${env:ProgramFiles}\WiX Toolset v3.14\bin",
        "${env:ProgramFiles}\WiX Toolset v3.11\bin"
    ) | ForEach-Object { $candidates += $_ }

    Get-ChildItem "${env:ProgramFiles(x86)}\WiX Toolset v*" -ErrorAction SilentlyContinue |
        ForEach-Object { $candidates += Join-Path $_.FullName 'bin' }
    Get-ChildItem "$env:ProgramFiles\WiX Toolset v*" -ErrorAction SilentlyContinue |
        ForEach-Object { $candidates += Join-Path $_.FullName 'bin' }

    foreach ($dir in ($candidates | Select-Object -Unique)) {
        if ($dir -and (Test-Path (Join-Path $dir 'candle.exe'))) {
            return $dir
        }
    }
    return $null
}

$wixBin = Find-WixBin
if (-not $wixBin) {
    throw @"
WiX Toolset introuvable.
Installez WiX 3.11+ depuis https://wixtoolset.org/ ou : choco install wixtoolset
"@
}

Write-Host "WiX: $wixBin"
Write-Host "Version installateur: $Version"

if (Test-Path $staging) {
    Remove-Item $staging -Recurse -Force
}
New-Item -ItemType Directory -Path $staging | Out-Null

Push-Location $backendDir
try {
    & node scripts/build-rmm-windows-cmd.mjs
    if ($LASTEXITCODE -ne 0) {
        throw 'Echec build-rmm-windows-cmd.mjs'
    }

    $cmdContent = (
        & node --input-type=module -e @"
import { buildSimpleWindowsLauncherCmd } from './utils/rmmAgentPackage.js';
process.stdout.write(buildSimpleWindowsLauncherCmd());
"@ | Out-String
    ).TrimEnd()
    if ($LASTEXITCODE -ne 0) {
        throw 'Echec generation du lanceur .cmd'
    }
} finally {
    Pop-Location
}

$setupPs1 = Join-Path $agentDir 'VeritasAgent-Windows-Setup.ps1'
$inventoryPs1 = Join-Path $agentDir 'Get-VeritasInventory.ps1'
$heartbeatPs1 = Join-Path $agentDir 'Invoke-VeritasHeartbeat.ps1'
if (-not (Test-Path $setupPs1)) {
    throw "Script introuvable: $setupPs1"
}
if (-not (Test-Path $inventoryPs1)) {
    throw "Script introuvable: $inventoryPs1"
}
if (-not (Test-Path $heartbeatPs1)) {
    throw "Script introuvable: $heartbeatPs1"
}

Copy-Item $setupPs1 (Join-Path $staging 'VeritasAgent-Windows-Setup.ps1')
Copy-Item $inventoryPs1 (Join-Path $staging 'Get-VeritasInventory.ps1')
Copy-Item $heartbeatPs1 (Join-Path $staging 'Invoke-VeritasHeartbeat.ps1')

foreach ($agentScript in @('VeritasAgent-Windows-Setup.ps1', 'Invoke-VeritasHeartbeat.ps1')) {
    $target = Join-Path $staging $agentScript
    $content = [System.IO.File]::ReadAllText($target)
    $content = $content -replace '\$agentVersion\s*=\s*[''"][^''"]*[''"]', "`$agentVersion = '$Version'"
    $content = $content.Replace('__VERITAS_AGENT_BUILD__', $Version)
    [System.IO.File]::WriteAllText($target, $content, [System.Text.UTF8Encoding]::new($false))
}

$launcherCmd = Join-Path $staging 'VeritasAgent-Windows-Setup.cmd'
$installCmd = Join-Path $staging 'VeritasAgent-Windows-Install.cmd'
[System.IO.File]::WriteAllText($launcherCmd, ($cmdContent -replace "`n", "`r`n"), [System.Text.Encoding]::ASCII)
@'
@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Veritas Agent - Configuration

net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

set "CFG=%ProgramData%\VeritasAgent\config.json"
if exist "%CFG%" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0VeritasAgent-Windows-Setup.ps1" -UpgradeOnly
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0VeritasAgent-Windows-Setup.ps1" -ShowGui
)
if errorlevel 1 (
  echo.
  echo Echec de la configuration. Consultez %TEMP%\VeritasAgent-install.log
  pause
)
'@ | Set-Content -Path $installCmd -Encoding ASCII

$objDir = Join-Path $msiDir 'obj'
if (Test-Path $objDir) {
    Remove-Item $objDir -Recurse -Force
}
New-Item -ItemType Directory -Path $objDir | Out-Null

$candle = Join-Path $wixBin 'candle.exe'
$light = Join-Path $wixBin 'light.exe'
$wxs = Join-Path $msiDir 'Product.wxs'
$wixobj = Join-Path $objDir 'Product.wixobj'

$wixUtilExt = Join-Path $wixBin 'WixUtilExtension.dll'
& $candle -nologo -arch x64 -ext $wixUtilExt "-dStaging=$staging" $wxs -out $wixobj
if ($LASTEXITCODE -ne 0) {
    throw 'Echec candle (compilation WiX)'
}

if (Test-Path $outMsi) {
    Remove-Item $outMsi -Force
}

& $light -nologo -sice:ICE57 -ext $wixUtilExt $wixobj -out $outMsi
if ($LASTEXITCODE -ne 0) {
    throw 'Echec light (liaison MSI)'
}

if (-not (Test-Path $outMsi)) {
    throw 'MSI absent apres compilation.'
}

$size = (Get-Item $outMsi).Length
Write-Host "MSI genere: $outMsi ($size octets)"
