@echo off
chcp 65001 >nul
title M3 - extend offer
rem Extend the offer validity: M3-extend.bat 46 14  (0 days = no limit)
set "NODE=C:\Program Files\nodejs\node.exe"
cd /d "%~dp0"
"%NODE%" "%~dp0tools\extend-order.mjs" %1 %2
echo.
pause
