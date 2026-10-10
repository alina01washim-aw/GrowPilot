# Quick firmware build check — run from the repo root:
#   powershell -ExecutionPolicy Bypass -File firmware/verify.ps1
#
# Exits non-zero if the build fails. Use this before flashing or committing
# firmware changes so SCD40 / relay regressions never reach the device.
$ErrorActionPreference = "Stop"

$firmwareDir = Join-Path (Split-Path -Parent $PSScriptRoot) "firmware"
$pio = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\pio.exe"
if (-not (Test-Path -LiteralPath $pio)) { $pio = "pio" }

Push-Location $firmwareDir
try {
    & $pio run
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
