param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,
  [string]$HostPath = "$PSScriptRoot\target\release\fuck-ddl-edge-host.exe"
)

$resolvedHost = (Resolve-Path -LiteralPath $HostPath).Path
$manifestPath = Join-Path $env:LOCALAPPDATA "FuckDDL\NativeMessaging\com.fuckddl.edge_host.json"
$manifestDirectory = Split-Path -Parent $manifestPath
New-Item -ItemType Directory -Force -Path $manifestDirectory | Out-Null

$manifest = Get-Content -Raw -LiteralPath "$PSScriptRoot\com.fuckddl.edge_host.template.json"
$manifest = $manifest.Replace('${HOST_PATH}', $resolvedHost.Replace('\', '\\'))
$manifest = $manifest.Replace('${EXTENSION_ID}', $ExtensionId)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8NoBom)

$registryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.fuckddl.edge_host"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

Write-Output "Registered com.fuckddl.edge_host for Edge extension $ExtensionId"
