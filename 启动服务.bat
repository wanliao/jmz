@echo off
rem ===========================================================
rem  Kimuzhi - PUBG Mobile weekly likes tracker (launcher)
rem  NOTE: keep this file ASCII-only. cmd.exe reads .bat files
rem  using the OEM codepage, so non-ASCII text here breaks parsing.
rem  Chinese messages are printed by Node.js after "chcp 65001".
rem
rem  Double-click to start the server. Closing the window stops it.
rem  Auto start on login: scripts\install-autostart.ps1
rem  Needs Node.js 22.5+ (built-in SQLite); Node 24 LTS recommended.
rem ===========================================================
chcp 65001 >nul
cd /d "%~dp0"
title Kimuzhi Weekly Likes port 8787

where node >nul 2>nul
if errorlevel 1 goto NONODE

node --disable-warning=ExperimentalWarning server\index.js

echo.
echo   Server stopped. Press any key to close this window.
pause >nul
exit /b 0

:NONODE
echo.
echo   [X] Node.js not found.
echo.
echo       Please install Node.js 22.5 or newer (24 LTS recommended),
echo       because this app uses the built-in SQLite module:
echo         https://nodejs.org/
echo.
echo       Then double-click this file again.
echo       See README.md section 1 for details.
echo.
pause
exit /b 1
