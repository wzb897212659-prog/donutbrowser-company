[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ChromiumSource,
  [string]$OutputName = 'Company'
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($ChromiumSource)
$kitRoot = Split-Path -Parent $PSScriptRoot
$argsSource = Join-Path $kitRoot 'build\args.gn'
$output = Join-Path $source "out\$OutputName"

foreach ($command in @('gn', 'autoninja')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required Chromium build command is unavailable: $command"
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $source 'chrome\VERSION') -PathType Leaf)) {
  throw "ChromiumSource is incomplete: $source"
}

New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item -LiteralPath $argsSource -Destination (Join-Path $output 'args.gn') -Force

Push-Location $source
try {
  & gn gen "out/$OutputName" --fail-on-unused-args
  if ($LASTEXITCODE -ne 0) { throw "gn gen failed: $LASTEXITCODE" }

  & autoninja -C "out/$OutputName" chrome
  if ($LASTEXITCODE -ne 0) { throw "Chromium build failed: $LASTEXITCODE" }
} finally {
  Pop-Location
}

$chrome = Join-Path $output 'chrome.exe'
if (-not (Test-Path -LiteralPath $chrome -PathType Leaf)) {
  throw "Build completed without chrome.exe: $chrome"
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $chrome).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $chrome).Length
Write-Host "Built $chrome"
Write-Host "chrome.exe size=$size sha256=$hash"

