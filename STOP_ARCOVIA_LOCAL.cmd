@echo off
setlocal
cd /d "%~dp0"

if not exist "data\local-runtime\supervisor.pid" (
  echo Arcovia local runtime is not running.
  pause
  exit /b 0
)

set /p ARCOVIA_PID=<"data\local-runtime\supervisor.pid"
taskkill /PID %ARCOVIA_PID% /T >nul 2>nul
if errorlevel 1 (
  echo Arcovia runtime could not be stopped or was already closed.
) else (
  echo Arcovia local server, tunnel and agents were stopped.
)
pause
