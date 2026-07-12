@echo off
setlocal
cd /d "%~dp0.."
title Arcovia Sourcing Agents - RUNNING

if "%LOCAL_CODEX_MULTI_AGENT_ENABLED%"=="" set "LOCAL_CODEX_MULTI_AGENT_ENABLED=true"
if "%LOCAL_CODEX_AGENT_CONCURRENCY%"=="" set "LOCAL_CODEX_AGENT_CONCURRENCY=2"
if "%LOCAL_CODEX_WORKER_POLL_SECONDS%"=="" set "LOCAL_CODEX_WORKER_POLL_SECONDS=60"
if "%LOCAL_CODEX_MODEL%"=="" set "LOCAL_CODEX_MODEL=gpt-5.6-luna"
if "%LOCAL_CODEX_REASONING_EFFORT%"=="" set "LOCAL_CODEX_REASONING_EFFORT=low"

echo Checking for an existing Arcovia local worker...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$existing = Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*scripts\local-codex-worker.js*' -or $_.CommandLine -like '*scripts/local-codex-worker.js*') -and $_.ProcessId -ne $PID }; if ($existing) { exit 23 }"
if errorlevel 23 (
  echo An Arcovia sourcing worker is already running. It was left running so an active research pass is not interrupted.
  echo Use scripts\stop-local-codex-worker.cmd only when you intentionally want to stop it.
  pause
  exit /b 0
)

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "CODEX_EXE=%USERPROFILE%\.codex\plugins\.plugin-appserver\codex.exe"
if not exist "%USERPROFILE%\.codex\plugins\.plugin-appserver\codex-code-mode-host.exe" set "CODEX_EXE=%USERPROFILE%\.codex\.sandbox-bin\codex.exe"
if not exist "%CODEX_EXE%" set "CODEX_EXE=%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe"
if exist "%CODEX_EXE%" set "CODEX_BIN=%CODEX_EXE%"
echo.
echo Arcovia sourcing agents are starting in multi-agent mode.
echo Close this window or run scripts\stop-local-codex-worker.cmd to stop them.
echo.

if exist "%NODE_EXE%" (
  "%NODE_EXE%" scripts\local-codex-worker.js
) else (
  node scripts\local-codex-worker.js
)
pause
