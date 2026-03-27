# Complete build pipeline: models → PyInstaller → Tauri exe → Inno Setup installer.
# Run from project root:
#   powershell -ExecutionPolicy Bypass -File scripts\build_installer.ps1
#
# Prerequisites:
#   - Python with all dependencies installed (pip install -e .)
#   - PyInstaller installed (pip install pyinstaller)
#   - Rust toolchain + cargo-tauri (cargo install tauri-cli)
#   - Node.js + npm
#   - Inno Setup 6 installed (choco install innosetup)
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
    Write-Host "[1/7] Laddar ned modeller..." -ForegroundColor Yellow
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
    Write-Host "[1/7] Hoppar över modellnedladdning (--SkipModels)" -ForegroundColor Yellow
}
Write-Host ""

# --- Step 2: Build PyInstaller sidecar ---
if (-not $SkipSidecar) {
    Write-Host "[2/7] Bygger PyInstaller-sidecar..." -ForegroundColor Yellow
    python -m PyInstaller sidecar.spec --noconfirm
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  PyInstaller misslyckades!" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK" -ForegroundColor Green
} else {
    Write-Host "[2/7] Hoppar över sidecar-bygg (--SkipSidecar)" -ForegroundColor Yellow
}
Write-Host ""

# --- Step 3: Copy models into sidecar dist ---
Write-Host "[3/7] Kopierar modeller till sidecar..." -ForegroundColor Yellow
$modelsSource = Join-Path $ProjectRoot "models"
$modelsDest = Join-Path $ProjectRoot "dist\motesskribent-sidecar\models"

if (-not (Test-Path $modelsSource)) {
    Write-Host "  FEL: models/ finns inte!" -ForegroundColor Red
    exit 1
}
if (Test-Path $modelsDest) {
    Remove-Item -Recurse -Force $modelsDest
}
# Use robocopy instead of Copy-Item to handle symlinks correctly.
# robocopy exit codes 0-7 are success.
robocopy $modelsSource $modelsDest /E /DCOPY:DAT /COPY:DAT /NFL /NDL /NJH /NJS
if ($LASTEXITCODE -ge 8) {
    Write-Host "  robocopy misslyckades (exit code $LASTEXITCODE)!" -ForegroundColor Red
    exit 1
}
$LASTEXITCODE = 0
Write-Host "  OK" -ForegroundColor Green
Write-Host ""

# --- Step 4: Copy sidecar into Tauri resources ---
Write-Host "[4/7] Kopierar sidecar till src-tauri/sidecar/..." -ForegroundColor Yellow
$sidecarDest = Join-Path $ProjectRoot "src-tauri\sidecar"

if (Test-Path $sidecarDest) {
    Remove-Item -Recurse -Force $sidecarDest
}
$sidecarSource = Join-Path $ProjectRoot "dist\motesskribent-sidecar"
robocopy $sidecarSource $sidecarDest /E /DCOPY:DAT /COPY:DAT /NFL /NDL /NJH /NJS
if ($LASTEXITCODE -ge 8) {
    Write-Host "  robocopy misslyckades (exit code $LASTEXITCODE)!" -ForegroundColor Red
    exit 1
}
$LASTEXITCODE = 0
Write-Host "  OK" -ForegroundColor Green
Write-Host ""

# --- Step 5: Build Tauri app (without bundler) ---
Write-Host "[5/7] Bygger Tauri-app (utan NSIS)..." -ForegroundColor Yellow
Set-Location (Join-Path $ProjectRoot "src-tauri")

# Ensure cargo is in PATH
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $env:Path += ";$env:USERPROFILE\.cargo\bin"
}

cargo tauri build --bundles none
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Tauri build misslyckades!" -ForegroundColor Red
    exit 1
}
Write-Host "  OK" -ForegroundColor Green
Set-Location $ProjectRoot
Write-Host ""

# --- Step 6: Download WebView2 bootstrapper ---
Write-Host "[6/7] Laddar ned WebView2-bootstrapper..." -ForegroundColor Yellow
$webview2Path = Join-Path $ProjectRoot "src-tauri\MicrosoftEdgeWebview2Setup.exe"
if (-not (Test-Path $webview2Path)) {
    Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $webview2Path
}
Write-Host "  OK" -ForegroundColor Green
Write-Host ""

# --- Step 7: Build Inno Setup installer ---
Write-Host "[7/7] Bygger Inno Setup-installer..." -ForegroundColor Yellow

# Find Inno Setup compiler
$iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) {
    # Try PATH
    $iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
    if (-not $iscc) {
        Write-Host "  FEL: Inno Setup hittades inte! Installera med: choco install innosetup" -ForegroundColor Red
        exit 1
    }
}

# Read version from pyproject.toml
$versionLine = Select-String -Path (Join-Path $ProjectRoot "pyproject.toml") -Pattern '^version\s*=\s*"(.+)"'
$version = $versionLine.Matches[0].Groups[1].Value

& $iscc /DMyAppVersion=$version (Join-Path $ProjectRoot "scripts\installer.iss")
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Inno Setup misslyckades!" -ForegroundColor Red
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
$outputDir = Join-Path $ProjectRoot "output"
if (Test-Path $outputDir) {
    $installers = Get-ChildItem $outputDir -Filter "*-setup.exe"
    foreach ($installer in $installers) {
        $sizeMB = [math]::Round($installer.Length / 1MB, 1)
        Write-Host "Installer: $($installer.FullName)" -ForegroundColor Cyan
        Write-Host "Storlek:   $sizeMB MB"
    }
}
