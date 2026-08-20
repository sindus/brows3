# Brows3 uninstaller (Windows).
# Usage: irm https://raw.githubusercontent.com/sindus/brows3/main/install/uninstall.ps1 | iex
$ErrorActionPreference = 'Stop'

$uninstallExe = Join-Path $env:LOCALAPPDATA 'Brows3\uninstall.exe'

if (-not (Test-Path $uninstallExe)) {
    throw "Brows3 installation not found at $uninstallExe."
}

Write-Host "Uninstalling Brows3 (silent)..."
Start-Process -FilePath $uninstallExe -ArgumentList '/S' -Wait

Write-Host "Brows3 removed."
