param(
  [string]$ExtensionId = 'bmgncdcgmoipddgpenggkjehldkamknb'
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

Write-Host '[1/6] Running the complete quality gate...'
Invoke-Checked -Command 'pnpm' -Arguments @('check')
Invoke-Checked -Command 'cargo' -Arguments @(
  'test', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml'
)
Invoke-Checked -Command 'cargo' -Arguments @(
  'test', '--manifest-path', 'apps/native-host/Cargo.toml'
)

Write-Host '[2/6] Building the Edge Native Host...'
Invoke-Checked -Command 'cargo' -Arguments @(
  'build', '--manifest-path', 'apps/native-host/Cargo.toml', '--release'
)

Write-Host '[3/6] Building the Windows installer...'
Invoke-Checked -Command 'pnpm' -Arguments @('desktop:installer')

$config = Get-Content -Raw -LiteralPath 'apps/desktop/src-tauri/tauri.conf.json' |
  ConvertFrom-Json
$version = [string]$config.version
$installer = Join-Path $projectRoot (
  "apps/desktop/src-tauri/target/release/bundle/nsis/Fuck DDL_${version}_x64-setup.exe"
)
if (-not (Test-Path -LiteralPath $installer)) {
  throw "Installer was not produced: $installer"
}

Write-Host "[4/6] Installing Fuck DDL $version..."
$runningApps = @(Get-Process -Name 'fuck-ddl' -ErrorAction SilentlyContinue)
foreach ($runningApp in $runningApps) {
  if ($runningApp.MainWindowHandle -ne 0) {
    [void]$runningApp.CloseMainWindow()
    [void]$runningApp.WaitForExit(5000)
  }
  if (-not $runningApp.HasExited) {
    $runningApp | Stop-Process -Force
  }
}
Start-Process -FilePath $installer -ArgumentList '/S' -Wait -WindowStyle Hidden

Write-Host '[5/6] Registering the existing Edge extension ID...'
& (Join-Path $projectRoot 'apps/native-host/install-host.ps1') `
  -ExtensionId $ExtensionId

$installedApp = Join-Path $env:USERPROFILE 'Fuck DDL\fuck-ddl.exe'
Start-Process -FilePath $installedApp
Start-Sleep -Seconds 5

Write-Host '[6/6] Verifying version and desktop bridge...'
$installed = Get-Item -LiteralPath $installedApp
if ($installed.VersionInfo.FileVersion -ne $version) {
  throw "Installed version $($installed.VersionInfo.FileVersion) does not match $version"
}

$appData = Join-Path $env:LOCALAPPDATA 'com.fuckddl.desktop'
$endpoint = (Get-Content -Raw -LiteralPath (
  Join-Path $appData 'edge-bridge.endpoint'
)).Trim()
$endpointParts = $endpoint.Split(':')
if ($endpointParts.Count -ne 2 -or $endpointParts[0] -ne '127.0.0.1') {
  throw "Unsafe desktop bridge endpoint: $endpoint"
}
$bridgePort = [int]$endpointParts[1]
$token = (Get-Content -Raw -LiteralPath (
  Join-Path $appData 'edge-bridge.token'
)).Trim()
$client = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $bridgePort)
try {
  $stream = $client.GetStream()
  $writer = [System.IO.StreamWriter]::new(
    $stream,
    [System.Text.UTF8Encoding]::new($false)
  )
  $writer.AutoFlush = $true
  $reader = [System.IO.StreamReader]::new(
    $stream,
    [System.Text.Encoding]::UTF8
  )
  $event = @{
    token = $token
    event = @{
      type = 'bridge-ping'
      domain = 'local'
      observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
  } | ConvertTo-Json -Compress -Depth 4
  $writer.WriteLine($event)
  $reply = $reader.ReadLine()
  if ($reply -ne '{"accepted":true}') {
    throw "Desktop bridge rejected the ping: $reply"
  }
} finally {
  $client.Dispose()
}

$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
Write-Host "PASS: Fuck DDL $version installed and bridge accepted the ping."
Write-Host "Installer: $installer"
Write-Host "SHA256: $hash"
