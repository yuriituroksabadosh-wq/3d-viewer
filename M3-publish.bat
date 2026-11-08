@echo off
chcp 65001 >nul
title M3 - publish order
rem Publish a BAZIS order: drag the order folder (or its .dae) onto this file,
rem or the BAZIS script starts it automatically (folder is passed via publish-request.txt).
set "NODE=C:\Program Files\nodejs\node.exe"
cd /d "%~dp0"
if not "%~1"=="" goto witharg
if exist "%~dp0publish-request.txt" goto fromfile
set /p "ORDER=Order folder path: "
"%NODE%" "%~dp0tools\publish-order.mjs" "%ORDER%"
goto done
:witharg
"%NODE%" "%~dp0tools\publish-order.mjs" "%~1"
goto done
:fromfile
"%NODE%" "%~dp0tools\publish-order.mjs"
:done
echo.
pause
