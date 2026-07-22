$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$hostExe = Join-Path $projectRoot 'target\release\fuck-ddl-edge-host.exe'
$localAppData = Join-Path $projectRoot '.e2e\localappdata'
$tokenDirectory = Join-Path $localAppData 'com.fuckddl.desktop'
$tokenPath = Join-Path $tokenDirectory 'edge-bridge.token'
$token = 'A' * 48

New-Item -ItemType Directory -Force -Path $tokenDirectory | Out-Null
[System.IO.File]::WriteAllText($tokenPath, $token)
$env:LOCALAPPDATA = $localAppData

$listener = [System.Net.Sockets.TcpListener]::new(
  [System.Net.IPAddress]::Loopback,
  47831
)
$listener.Start()

try {
  $acceptTask = $listener.AcceptTcpClientAsync()
  $event = @{
    type = 'domain-threshold'
    domain = 'video.example.com'
    observedAt = 600000
  } | ConvertTo-Json -Compress
  $payload = [System.Text.Encoding]::UTF8.GetBytes($event)

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $hostExe
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $lengthPrefix = [System.BitConverter]::GetBytes([uint32]$payload.Length)
  $process.StandardInput.BaseStream.Write($lengthPrefix, 0, $lengthPrefix.Length)
  $process.StandardInput.BaseStream.Write($payload, 0, $payload.Length)
  $process.StandardInput.BaseStream.Flush()
  $process.StandardInput.Close()

  if (-not $acceptTask.Wait([TimeSpan]::FromSeconds(5))) {
    throw 'Native host did not connect to the desktop bridge'
  }
  $client = $acceptTask.Result
  $reader = [System.IO.StreamReader]::new($client.GetStream())
  $line = $reader.ReadLine()
  $envelope = $line | ConvertFrom-Json
  if ($envelope.token -ne $token) { throw 'Bridge token mismatch' }
  if ($envelope.event.domain -ne 'video.example.com') { throw 'Domain mismatch' }
  if ($envelope.event.type -ne 'domain-threshold') { throw 'Event type mismatch' }

  $writer = [System.IO.StreamWriter]::new($client.GetStream())
  $writer.NewLine = "`n"
  $writer.WriteLine('{"accepted":true}')
  $writer.Flush()

  $lengthBytes = New-Object byte[] 4
  [void]$process.StandardOutput.BaseStream.Read($lengthBytes, 0, 4)
  $responseLength = [System.BitConverter]::ToUInt32($lengthBytes, 0)
  $responseBytes = New-Object byte[] $responseLength
  [void]$process.StandardOutput.BaseStream.Read($responseBytes, 0, $responseLength)
  $response = [System.Text.Encoding]::UTF8.GetString($responseBytes) | ConvertFrom-Json
  if (-not $response.ok) { throw "Host response failed: $($response.error)" }

  [void]$process.WaitForExit(5000)
  $writer.Dispose()
  $reader.Dispose()
  $client.Dispose()
  Write-Output 'Native Messaging end-to-end test passed'
}
finally {
  $listener.Stop()
}
