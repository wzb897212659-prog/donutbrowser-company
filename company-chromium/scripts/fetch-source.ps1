[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DestinationRoot
)

$ErrorActionPreference = 'Stop'
$baseCommit = '031bfd60f544af71d8dd7246970d1af3e1acf3ad'
$destination = [System.IO.Path]::GetFullPath($DestinationRoot)

foreach ($command in @('fetch', 'gclient', 'git')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required Chromium build command is unavailable: $command"
  }
}

if (Test-Path -LiteralPath $destination) {
  throw "DestinationRoot must not already exist: $destination"
}

$parent = Split-Path -Parent $destination
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
  New-Item -ItemType Directory -Path $parent | Out-Null
}

New-Item -ItemType Directory -Path $destination | Out-Null
Push-Location $destination
try {
  & fetch --nohooks chromium
  if ($LASTEXITCODE -ne 0) { throw "fetch chromium failed: $LASTEXITCODE" }

  & git -C src fetch origin $baseCommit
  if ($LASTEXITCODE -ne 0) { throw "git fetch of the frozen base failed: $LASTEXITCODE" }

  & git -C src checkout --detach $baseCommit
  if ($LASTEXITCODE -ne 0) { throw "git checkout of the frozen base failed: $LASTEXITCODE" }

  & gclient sync -D --force --revision "src@$baseCommit"
  if ($LASTEXITCODE -ne 0) { throw "gclient sync failed: $LASTEXITCODE" }

  $actual = (& git -C src rev-parse HEAD).Trim()
  if ($actual -ne $baseCommit) {
    throw "Frozen Chromium base mismatch: $actual"
  }
} finally {
  Pop-Location
}

Write-Host "Chromium base prepared at $destination\src"

