@echo off
chcp 65001 >nul
title M3 - deploy worker
rem Updates the Cloudflare worker (notifications, bot, drill key, model file storage).
cd /d "%~dp0notify-worker"
set "PATH=C:\Program Files\nodejs;%PATH%"
call npx -y wrangler@4 deploy
echo.
pause
