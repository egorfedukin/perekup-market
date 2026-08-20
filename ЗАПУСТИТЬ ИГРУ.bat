@echo off
setlocal
cd /d "%~dp0"
set "GAME_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%GAME_NODE%" goto launch
where node >nul 2>nul
if errorlevel 1 goto missing
set "GAME_NODE=node"
:launch
start "Perekup Market Server" cmd /k ""%GAME_NODE%" server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:4173/"
exit /b 0
:missing
echo Node.js 22 or newer is required.
pause
