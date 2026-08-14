[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ChromiumSource
)

$ErrorActionPreference = 'Stop'
$baseCommit = '031bfd60f544af71d8dd7246970d1af3e1acf3ad'
$source = [System.IO.Path]::GetFullPath($ChromiumSource)
$kitRoot = Split-Path -Parent $PSScriptRoot
$patch = Join-Path $kitRoot 'patches\0001-company-persona-and-portable-os-crypt.patch'

if (-not (Test-Path -LiteralPath (Join-Path $source '.git') -PathType Container)) {
  throw "ChromiumSource is not a Git checkout: $source"
}
if (-not (Test-Path -LiteralPath $patch -PathType Leaf)) {
  throw "Frozen patch is missing: $patch"
}

$actual = (& git -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -ne $baseCommit) {
  throw "ChromiumSource must be at frozen base $baseCommit; found $actual"
}

$status = & git -C $source status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect ChromiumSource status' }
if ($status) { throw 'ChromiumSource must be clean before applying the patch' }

& git -C $source apply --check --whitespace=error-all $patch
if ($LASTEXITCODE -ne 0) { throw "Patch preflight failed: $LASTEXITCODE" }

& git -C $source apply --whitespace=error-all $patch
if ($LASTEXITCODE -ne 0) { throw "Patch application failed: $LASTEXITCODE" }

Write-Host 'Company Chromium patch applied successfully.'

