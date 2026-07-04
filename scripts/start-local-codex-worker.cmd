@echo off
setlocal
cd /d "%~dp0.."
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_EXE%" (
  "%NODE_EXE%" scripts\local-codex-worker.js
) else (
  node scripts\local-codex-worker.js
)
pause
