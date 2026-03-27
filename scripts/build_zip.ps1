# Complete release pipeline: build installer + package zip.
# Run from project root:
#   powershell -ExecutionPolicy Bypass -File scripts\build_zip.ps1
#
# This script runs the full build_installer.ps1 pipeline, then packages
# the Inno Setup installer together with docs into a release zip.

param(
    [switch]$SkipModels,    # Skip model download (if already done)
    [switch]$SkipSidecar,   # Skip sidecar build (if already done)
    [switch]$SkipBuild      # Skip full build (only re-package zip from existing artifacts)
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

# Read version from pyproject.toml
$versionLine = Select-String -Path (Join-Path $ProjectRoot "pyproject.toml") -Pattern '^version\s*=\s*"(.+)"'
$version = $versionLine.Matches[0].Groups[1].Value
$zipName = "MotesSkribent_${version}_x64.zip"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  MotesSkribent v$version - Release-paketering" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Run full build pipeline ---
if (-not $SkipBuild) {
    Write-Host '[1/2] Kor komplett bygg-pipeline...' -ForegroundColor Yellow
    $buildArgs = @()
    if ($SkipModels) { $buildArgs += "-SkipModels" }
    if ($SkipSidecar) { $buildArgs += "-SkipSidecar" }

    $buildScript = Join-Path $ProjectRoot "scripts\build_installer.ps1"
    & powershell -ExecutionPolicy Bypass -File $buildScript @buildArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  Bygg-pipeline misslyckades!' -ForegroundColor Red
        exit 1
    }
    Write-Host '  OK' -ForegroundColor Green
} else {
    Write-Host '[1/2] Hoppar over bygg (-SkipBuild)' -ForegroundColor Yellow
}
Write-Host ""

# --- Step 2: Package release zip ---
Write-Host '[2/2] Skapar release-paket...' -ForegroundColor Yellow

$releaseDir = Join-Path $ProjectRoot "release"
if (Test-Path $releaseDir) {
    Remove-Item -Recurse -Force $releaseDir
}
New-Item -ItemType Directory -Path $releaseDir | Out-Null

# Find Inno Setup installer
$outputDir = Join-Path $ProjectRoot "output"
if (-not (Test-Path $outputDir)) {
    Write-Host "  FEL: output/-katalog saknas: $outputDir" -ForegroundColor Red
    exit 1
}
$installers = Get-ChildItem $outputDir -Filter "*-setup.exe"
if ($installers.Count -eq 0) {
    Write-Host '  FEL: Ingen Inno Setup-installer hittad!' -ForegroundColor Red
    exit 1
}

# Copy installer
foreach ($installer in $installers) {
    Copy-Item $installer.FullName $releaseDir
    $sizeMB = [math]::Round($installer.Length / 1MB, 1)
    Write-Host ('  Installer: {0} ({1} MB)' -f $installer.Name, $sizeMB)
}

# Copy docs
$changelogSrc = Join-Path $ProjectRoot "CHANGELOG.md"
$installSrc = Join-Path $ProjectRoot "INSTALLATION.md"
Copy-Item $changelogSrc $releaseDir
Copy-Item $installSrc $releaseDir

# Create zip
$zipPath = Join-Path $ProjectRoot $zipName
if (Test-Path $zipPath) {
    Remove-Item $zipPath
}
Compress-Archive -Path "$releaseDir\*" -DestinationPath $zipPath
$zipSizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host '  OK' -ForegroundColor Green

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Release-paket klart!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Zip: $zipPath" -ForegroundColor Cyan
Write-Host ('Storlek: {0} MB' -f $zipSizeMB)
Write-Host ""
Write-Host 'Innehall:'
Get-ChildItem $releaseDir | ForEach-Object {
    $s = [math]::Round($_.Length / 1MB, 1)
    Write-Host ('  {0} ({1} MB)' -f $_.Name, $s)
}
