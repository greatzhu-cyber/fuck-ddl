param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Fa-f]{40}$')]
  [string]$CertificateThumbprint,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https?://')]
  [string]$TimestampUrl,

  [switch]$UseRfc3161Timestamp,
  [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$env:CI = 'true'

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Find-CodeSigningCertificate {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Thumbprint
  )

  $normalized = $Thumbprint.Replace(' ', '').ToUpperInvariant()
  $matches = @(
    Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
      Where-Object { $_.Thumbprint -eq $normalized }
  )
  if ($matches.Count -ne 1) {
    throw "Expected exactly one CurrentUser code-signing certificate for thumbprint $normalized; found $($matches.Count)."
  }

  $certificate = $matches[0]
  $now = Get-Date
  if (-not $certificate.HasPrivateKey) {
    throw 'The selected code-signing certificate has no accessible private key.'
  }
  if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
    throw 'The selected code-signing certificate is not currently valid.'
  }

  return $certificate
}

function Assert-CleanWorktree {
  & git diff --quiet
  if ($LASTEXITCODE -ne 0) {
    throw 'The Git working tree must be clean before a signed release build.'
  }
  & git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    throw 'The Git index must be clean before a signed release build.'
  }
}

function Assert-ValidSignature {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Signed artifact was not produced: $Path"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne 'Valid') {
    throw "Authenticode validation failed for ${Path}: $($signature.Status)"
  }
}

$certificate = Find-CodeSigningCertificate -Thumbprint $CertificateThumbprint
Write-Host "Certificate preflight passed: $($certificate.Subject)"
Write-Host "Certificate expires: $($certificate.NotAfter.ToString('u'))"

if ($PreflightOnly) {
  Write-Host 'PASS: signing certificate preflight completed; no build was started.'
  exit 0
}

Assert-CleanWorktree

$config = Get-Content -Raw -LiteralPath (
  Join-Path $projectRoot 'apps/desktop/src-tauri/tauri.conf.json'
) | ConvertFrom-Json
$version = [string]$config.version

$temporaryConfig = Join-Path (
  [System.IO.Path]::GetTempPath()
) "fuck-ddl-signing-$([guid]::NewGuid().ToString('N')).json"
$signingConfig = @{
  bundle = @{
    windows = @{
      certificateThumbprint = $certificate.Thumbprint
      digestAlgorithm = 'sha256'
      timestampUrl = $TimestampUrl
      tsp = [bool]$UseRfc3161Timestamp
    }
  }
} | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText(
  $temporaryConfig,
  $signingConfig,
  [System.Text.UTF8Encoding]::new($false)
)

try {
  Write-Host '[1/4] Running the complete quality gate...'
  Invoke-Checked -Command 'pnpm' -Arguments @('check')

  Write-Host '[2/4] Building the signed desktop application and NSIS installer...'
  Invoke-Checked -Command 'pnpm' -Arguments @(
    '--filter', '@fuck-ddl/desktop', 'tauri', 'build',
    '--bundles', 'nsis', '--config', $temporaryConfig
  )

  Write-Host '[3/4] Building and signing the Edge Native Host...'
  Invoke-Checked -Command 'cargo' -Arguments @(
    'build', '--manifest-path', 'apps/native-host/Cargo.toml', '--release'
  )

  $signTool = Get-ChildItem `
    -LiteralPath 'C:\Program Files (x86)\Windows Kits\10\bin' `
    -Recurse -Filter signtool.exe -File |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if (-not $signTool) {
    throw 'Windows SDK x64 signtool.exe was not found.'
  }

  $nativeHost = Join-Path $projectRoot (
    'apps/native-host/target/release/fuck-ddl-edge-host.exe'
  )
  $timestampArguments = if ($UseRfc3161Timestamp) {
    @('/tr', $TimestampUrl, '/td', 'SHA256')
  } else {
    @('/t', $TimestampUrl)
  }
  $signArguments = @(
    'sign', '/sha1', $certificate.Thumbprint, '/fd', 'SHA256'
  ) + $timestampArguments + @($nativeHost)
  Invoke-Checked -Command $signTool -Arguments $signArguments

  Write-Host '[4/4] Verifying Authenticode signatures and hashes...'
  $desktopExe = Join-Path $projectRoot (
    'apps/desktop/src-tauri/target/release/fuck-ddl.exe'
  )
  $installer = Join-Path $projectRoot (
    "apps/desktop/src-tauri/target/release/bundle/nsis/Fuck DDL_${version}_x64-setup.exe"
  )
  $artifacts = @($desktopExe, $installer, $nativeHost)
  foreach ($artifact in $artifacts) {
    Assert-ValidSignature -Path $artifact
    $hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
    Write-Host "VALID: $artifact"
    Write-Host "SHA256: $hash"
  }
} finally {
  Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
}

Write-Host "PASS: Fuck DDL $version signed Windows release artifacts are valid."