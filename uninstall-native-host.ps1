$ErrorActionPreference = "Stop"

$hostName = "com.audio_recorder.whisper_host"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $scriptDir "native-host-manifest.json"
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (Test-Path -LiteralPath $registryPath) {
  Remove-Item -LiteralPath $registryPath -Force
}

if (Test-Path -LiteralPath $manifestPath) {
  Remove-Item -LiteralPath $manifestPath -Force
}

Write-Host "Native host registration removed."
