@echo off
chcp 65001 >nul
title M3 - cancel order
rem Cancel an order: the customer loses access to the 3D model and KP, bot messages are removed.
set "NODE=C:\Program Files\nodejs\node.exe"
cd /d "%~dp0"
"%NODE%" "%~dp0tools\revoke-order.mjs" %1
echo.
pause
