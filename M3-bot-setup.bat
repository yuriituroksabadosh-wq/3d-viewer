@echo off
chcp 65001 >nul
title M3 - bot setup
rem One-time bot setup: stats commands and client messages forwarding.
set "NODE=C:\Program Files\nodejs\node.exe"
cd /d "%~dp0"
"%NODE%" "%~dp0tools\setup-bot.mjs"
echo.
pause
