$ErrorActionPreference = 'Stop'

$nativeHostRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installScript = Join-Path $nativeHostRoot 'install-host.ps1'
$expectedHost = (Resolve-Path (Join-Path $nativeHostRoot 'target\release\fuck-ddl-edge-host.exe')).Path

$defaultHost = (& $installScript -ExtensionId 'test-extension-id' -ResolveOnly).Trim()
if ($defaultHost -ne $expectedHost) {
  throw "Default Host path mismatch. Expected '$expectedHost', got '$defaultHost'."
}

$explicitHost = (& $installScript -ExtensionId 'test-extension-id' -HostPath $expectedHost -ResolveOnly).Trim()
if ($explicitHost -ne $expectedHost) {
  throw "Explicit Host path mismatch. Expected '$expectedHost', got '$explicitHost'."
}

Write-Output 'install-host default and explicit path tests passed'