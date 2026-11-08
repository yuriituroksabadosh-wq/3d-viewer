@echo off
chcp 65001 >nul
title M3 - publish order
rem Publish a BAZIS order: drag the order folder (or its .dae) onto this file,
rem or the BAZIS script starts it automatically.
set "NODE=C:\Program Files\nodejs\node.exe"
cd /d "%~dp0"
if "%~1"=="" (
  set /p "ORDER=Order folder path: "
) else (
  set "ORDER=%~1"
)
"%NODE%" "%~dp0tools\publish-order.mjs" "%ORDER%"
echo.
pause
