@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PORT=3010"
"runtime\node.exe" "scripts\launch.js" --startup-window
pause
