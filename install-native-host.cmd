@echo off
setlocal

if "%~1"=="" (
  echo Usage: install-native-host.cmd EXTENSION_ID
  exit /b 1
)

powershell -ExecutionPolicy Bypass -File "%~dp0install-native-host.ps1" -ExtensionId "%~1"
