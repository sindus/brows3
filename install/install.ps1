# Brows3 installer (Windows).
# Usage: irm https://raw.githubusercontent.com/sindus/brows3/main/install/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo = 'sindus/brows3'
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"

Write-Host "Fetching the latest Brows3 release..."
$release = Invoke-RestMethod -Uri $apiUrl -Headers @{ 'User-Agent' = 'brows3-installer' }

$asset = $release.assets | Where-Object { $_.name -like '*_x64-setup.exe' } | Select-Object -First 1
if (-not $asset) {
    throw "Could not find a Windows installer asset. Download manually from https://github.com/$repo/releases/latest"
}

$outPath = Join-Path $env:TEMP 'Brows3-setup.exe'
Write-Host "Downloading $($asset.browser_download_url)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $outPath

# GitHub publishes a SHA-256 digest for each release asset.
if ($asset.digest -and $asset.digest.StartsWith('sha256:')) {
    $expected = $asset.digest.Substring(7)
    $actual = (Get-FileHash $outPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        Remove-Item $outPath -Force
        throw "Checksum mismatch for $($asset.name)."
    }
    Write-Host "Checksum verified."
} else {
    Write-Warning "No checksum published for this file; skipping verification."
}

Write-Host "Installing Brows3 (silent)..."
Start-Process -FilePath $outPath -ArgumentList '/S' -Wait

Write-Host "Brows3 installed."
