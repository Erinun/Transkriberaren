# Build the PyInstaller sidecar and copy models into it.
# Run from project root:
#   powershell -ExecutionPolicy Bypass -File scripts\build_sidecar.ps1

param(
    [switch]$SkipModels  # Skip model copy (for testing PyInstaller build only)
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

Write-Host "=== Bygger MötesSkribent sidecar ===" -ForegroundColor Cyan
Write-Host "Projektkatalog: $ProjectRoot"
Write-Host ""

# 1. Run PyInstaller
Write-Host "[1/3] Kör PyInstaller..." -ForegroundColor Yellow
python -m PyInstaller sidecar.spec --noconfirm
if ($LASTEXITCODE -ne 0) {
    Write-Host "PyInstaller misslyckades!" -ForegroundColor Red
    exit 1
}
Write-Host "  OK" -ForegroundColor Green

# 2. Copy models into the dist folder
if (-not $SkipModels) {
    Write-Host "[2/3] Kopierar modeller..." -ForegroundColor Yellow
    $modelsSource = Join-Path $ProjectRoot "models"
    $modelsDest = Join-Path $ProjectRoot "dist\motesskribent-sidecar\models"

    if (-not (Test-Path $modelsSource)) {
        Write-Host "  VARNING: models/ finns inte. Kör först: python scripts/download_models.py" -ForegroundColor Red
        exit 1
    }

    if (Test-Path $modelsDest) {
        Remove-Item -Recurse -Force $modelsDest
    }
    Copy-Item -Recurse $modelsSource $modelsDest
    Write-Host "  OK" -ForegroundColor Green
} else {
    Write-Host "[2/3] Hoppar över modellkopiering (--SkipModels)" -ForegroundColor Yellow
}

# 3. Copy to src-tauri/sidecar for Tauri bundling
Write-Host "[3/3] Kopierar till src-tauri/sidecar/..." -ForegroundColor Yellow
$sidecarDest = Join-Path $ProjectRoot "src-tauri\sidecar"

if (Test-Path $sidecarDest) {
    Remove-Item -Recurse -Force $sidecarDest
}
Copy-Item -Recurse (Join-Path $ProjectRoot "dist\motesskribent-sidecar") $sidecarDest
Write-Host "  OK" -ForegroundColor Green

Write-Host ""
Write-Host "=== Sidecar klar! ===" -ForegroundColor Cyan
$size = (Get-ChildItem -Recurse $sidecarDest | Measure-Object -Property Length -Sum).Sum
Write-Host ("Total storlek: {0:N2} GB" -f ($size / 1GB))
