param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$hostName = "com.audio_recorder.whisper_host"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostPath = Join-Path $scriptDir "native-host.cmd"
$manifestPath = Join-Path $scriptDir "native-host-manifest.json"
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (-not (Test-Path -LiteralPath $hostPath)) {
  throw "native-host.cmd was not found next to this script."
}

$manifest = @{
  name = $hostName
  description = "Tab Audio Recorder native transcription host"
  path = $hostPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$manifest |
  ConvertTo-Json -Depth 5 |
  Set-Content -LiteralPath $manifestPath -Encoding UTF8

New-Item -Path $registryPath -Force | Out-Null
& reg.exe add "HKCU\Software\Google\Chrome\NativeMessagingHosts\$hostName" /ve /t REG_SZ /d $manifestPath /f | Out-Null

Write-Host "Native host manifest written to $manifestPath"
Write-Host "Chrome registry entry updated for extension ID $ExtensionId"
Write-Host "Reload the unpacked extension before testing."
