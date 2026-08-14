[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Version,
    [Parameter(Mandatory = $true)] [string] $Artifact,
    [Parameter(Mandatory = $true)] [string] $Signature,
    [string] $Server = "ubuntu@124.221.228.102",
    [string] $SshKey = "$env:USERPROFILE\.ssh\hengzhang_tencent",
    [string] $Notes = "Sanhe Donut company release"
)

$ErrorActionPreference = "Stop"
$artifactPath = (Resolve-Path -LiteralPath $Artifact).Path
$signaturePath = (Resolve-Path -LiteralPath $Signature).Path
$artifactName = [IO.Path]::GetFileName($artifactPath)
$signatureText = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($signatureText)) {
    throw "The Tauri signature file is empty."
}

$sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
$staging = Join-Path ([IO.Path]::GetTempPath()) ("sanhe-donut-release-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    Copy-Item -LiteralPath $artifactPath -Destination (Join-Path $staging $artifactName)
    Set-Content -LiteralPath (Join-Path $staging "$artifactName.sha256") -Encoding ascii -NoNewline -Value "$sha256  $artifactName`n"
    $manifest = [ordered]@{
        version = $Version.TrimStart("v")
        notes = $Notes
        pub_date = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
        platforms = [ordered]@{
            "windows-x86_64" = [ordered]@{
                signature = $signatureText
                url = "https://browser.sanheqiyun.xyz/downloads/$artifactName"
            }
        }
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText(
        (Join-Path $staging "latest.json"),
        $manifestJson,
        [Text.UTF8Encoding]::new($false)
    )

    ssh -i $SshKey $Server "sudo install -d -m 0755 /srv/sanhe-donut/releases && sudo chown ubuntu:ubuntu /srv/sanhe-donut/releases"
    if ($LASTEXITCODE -ne 0) { throw "Failed to prepare the server release directory." }
    scp -i $SshKey (Join-Path $staging $artifactName) (Join-Path $staging "$artifactName.sha256") "${Server}:/srv/sanhe-donut/releases/"
    if ($LASTEXITCODE -ne 0) { throw "Failed to upload the signed release artifact." }
    $remoteManifest = "/tmp/sanhe-donut-latest-$([guid]::NewGuid().ToString('N')).json"
    scp -i $SshKey (Join-Path $staging "latest.json") "${Server}:${remoteManifest}"
    if ($LASTEXITCODE -ne 0) { throw "Failed to upload the release manifest." }
    ssh -i $SshKey $Server "sudo install -m 0644 '$remoteManifest' /srv/sanhe-donut/releases/latest.json && rm -f '$remoteManifest'"
    if ($LASTEXITCODE -ne 0) { throw "Failed to publish the release manifest." }
    Write-Host "Published $artifactName (SHA-256 $sha256) for version $Version."
}
finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
