@echo off
setlocal
cd /d "%~dp0"
title Arcovia Local Server and Email Agent

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

if not exist ".env" (
  echo Missing .env configuration file.
  echo Complete the Gmail and Cloudflare setup before starting Arcovia.
  pause
  exit /b 1
)

rem Load local secrets copied from the existing deployment and Google setup.
for %%V in (ARCOVIA_FLOW_SECRET ARCOVIA_FINAL_FLOW_SECRET SHOPIFY_CLIENT_ID SHOPIFY_CLIENT_SECRET SHOPIFY_STORE_DOMAIN SHOPIFY_ADMIN_API_VERSION SHOPIFY_FINAL_CHECKOUT_ENABLED SMTP_PASSWORD CLOUDFLARE_TUNNEL_TOKEN) do (
  for /f "tokens=1,2,*" %%A in ('reg query "HKCU\Environment" /v "%%V" 2^>nul ^| findstr /R /C:"REG_"') do set "%%V=%%C"
)

"%NODE_EXE%" --env-file=.env scripts\local-runtime-supervisor.js
pause
