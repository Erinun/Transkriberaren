# Complete build pipeline: models → PyInstaller → Tauri NSIS installer.
# Run from project root:
#   powershell -ExecutionPolicy Bypass -File scripts\build_installer.ps1
#
# Prerequisites:
#   - Python with all dependencies installed (pip install -e .)
#   - PyInstaller installed (pip install pyinstaller)
#   - Rust toolchain + cargo-tauri (cargo install tauri-cli)
#   - Node.js + npm
#   - No HF_TOKEN needed (all models are public)

param(
    [switch]$SkipModels,    # Skip model download (if already done)
    [switch]$SkipSidecar    # Skip sidecar build (if already done)
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  MötesSkribent — Komplett bygg-pipeline" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Download models ---
if (-not $SkipModels) {
    Write-Host "[1/5] Laddar ned modeller..." -ForegroundColor Yellow
    $modelsHub = Join-Path $ProjectRoot "models\hub"
    if (Test-Path $modelsHub) {
        Write-Host "  models/hub/ finns redan, hoppar över nedladdning"
        Write-Host "  (använd -SkipModels explicit för att vara tydlig)"
    } else {
        python scripts/download_models.py
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Modellnedladdning misslyckades!" -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "  OK" -ForegroundColor Green
} else {
    Write-Host "[1/5] Hoppar över modellnedladdning (--SkipModels)" -ForegroundColor Yellow
}
Write-Host ""

# --- Step 2: Build PyInstaller sidecar ---
if (-not $SkipSidecar) {
    Write-Host "[2/5] Bygger PyInstaller-sidecar..." -ForegroundColor Yellow
    python -m PyInstaller sidecar.spec --noconfirm
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  PyInstaller misslyckades!" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK" -ForegroundColor Green
} else {
    Write-Host "[2/5] Hoppar över sidecar-bygg (--SkipSidecar)" -ForegroundColor Yellow
}
Write-Host ""

# --- Step 3: Copy models into sidecar dist ---
Write-Host "[3/5] Kopierar modeller till sidecar..." -ForegroundColor Yellow
$modelsSource = Join-Path $ProjectRoot "models"
$modelsDest = Join-Path $ProjectRoot "dist\motesskribent-sidecar\models"

if (-not (Test-Path $modelsSource)) {
    Write-Host "  FEL: models/ finns inte!" -ForegroundColor Red
    exit 1
}
if (Test-Path $modelsDest) {
    Remove-Item -Recurse -Force $modelsDest
}
Copy-Item -Recurse $modelsSource $modelsDest
Write-Host "  OK" -ForegroundColor Green
Write-Host ""

# --- Step 4: Copy sidecar into Tauri resources ---
Write-Host "[4/5] Kopierar sidecar till src-tauri/sidecar/..." -ForegroundColor Yellow
$sidecarDest = Join-Path $ProjectRoot "src-tauri\sidecar"

if (Test-Path $sidecarDest) {
    Remove-Item -Recurse -Force $sidecarDest
}
Copy-Item -Recurse (Join-Path $ProjectRoot "dist\motesskribent-sidecar") $sidecarDest
Write-Host "  OK" -ForegroundColor Green
Write-Host ""

# --- Step 5: Build Tauri NSIS installer ---
Write-Host "[5/5] Bygger Tauri NSIS-installer..." -ForegroundColor Yellow
Set-Location (Join-Path $ProjectRoot "src-tauri")

# Ensure cargo is in PATH
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $env:Path += ";$env:USERPROFILE\.cargo\bin"
}

# Override bundle resources to include sidecar (base config has empty resources for dev mode)
# Resources already configured in tauri.conf.json (sidecar/**/*)

cargo tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Tauri build misslyckades!" -ForegroundColor Red
    exit 1
}
Write-Host "  OK" -ForegroundColor Green

Set-Location $ProjectRoot
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Bygget klart!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""

# Find the output installer
$nsisDir = Join-Path $ProjectRoot "src-tauri\target\release\bundle\nsis"
if (Test-Path $nsisDir) {
    $installers = Get-ChildItem $nsisDir -Filter "*.exe"
    foreach ($installer in $installers) {
        $sizeMB = [math]::Round($installer.Length / 1MB, 1)
        Write-Host "Installer: $($installer.FullName)" -ForegroundColor Cyan
        Write-Host "Storlek:   $sizeMB MB"
    }
}
